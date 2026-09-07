const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const heicConvert = require('heic-convert');
const app = express();
const port = process.env.PORT || 5000;
const Anthropic = require('@anthropic-ai/sdk');
// Middleware
app.use(cors());
app.use(express.json());

// Serve uploaded images statically so the frontend can display them
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
// Configure multer to save files into uploads/{item_id}/ (for permanent item photos)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const itemId = req.params.itemId;
    const dir = path.join(__dirname, 'uploads', String(itemId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max per file
  fileFilter: (req, file, cb) => {
    const isImageMime = file.mimetype.startsWith('image/');
    const isHeic = /\.heic$/i.test(file.originalname) || /\.heif$/i.test(file.originalname);
    if (isImageMime || isHeic) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Configure multer for temporary AI analysis uploads (no item exists yet)
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'temp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const uploadTemp = multer({
  storage: tempStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isImageMime = file.mimetype.startsWith('image/');
    const isHeic = /\.heic$/i.test(file.originalname) || /\.heif$/i.test(file.originalname);
    if (isImageMime || isHeic) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Test route - checks server is running
app.get('/', (req, res) => {
  res.json({ message: 'Stock Tracker backend is running!' });
});

// Test route - checks database connection
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      message: 'Database connected successfully!',
      time: result.rows[0].now
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database connection failed', details: err.message });
  }
});

// GET all items (including their images)
app.get('/api/items', async (req, res) => {
  try {
    const itemsResult = await pool.query(
      'SELECT * FROM items ORDER BY created_at DESC'
    );

    const imagesResult = await pool.query(
      'SELECT * FROM images WHERE is_deleted = FALSE ORDER BY created_at ASC'
    );

    const itemsWithImages = itemsResult.rows.map(item => ({
      ...item,
      images: imagesResult.rows.filter(img => img.item_id === item.id)
    }));

    res.json(itemsWithImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch items', details: err.message });
  }
});
// DELETE an item (and its images)
app.delete('/api/items/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the item's images first so we can delete the files from disk
    const imagesResult = await pool.query(
      'SELECT * FROM images WHERE item_id = $1',
      [id]
    );

    // Delete the item (images row will cascade-delete automatically due to ON DELETE CASCADE)
    const result = await pool.query(
      'DELETE FROM items WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Delete the actual image files from disk
    imagesResult.rows.forEach(img => {
      const filePath = path.join(__dirname, img.object_key);
      fs.unlink(filePath, (err) => {
        if (err) console.error('Failed to delete file:', filePath, err.message);
      });
    });

    // Also try to remove the now-empty item folder
    const itemFolder = path.join(__dirname, 'uploads', String(id));
    fs.rm(itemFolder, { recursive: true, force: true }, (err) => {
      if (err) console.error('Failed to remove folder:', itemFolder, err.message);
    });

    res.json({ message: 'Item deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete item', details: err.message });
  }
});
// UPDATE an item's full details
app.put('/api/items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      brand,
      category,
      size,
      condition,
      purchase_cost,
      box_number
    } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET brand = $1, category = $2, size = $3, condition = $4, 
           purchase_cost = $5, box_number = $6, updated_at = NOW()
       WHERE id = $7 
       RETURNING *`,
      [brand, category, size, condition, purchase_cost || null, box_number || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item', details: err.message });
  }
});
// CREATE a new item
app.post('/api/items', async (req, res) => {
  try {
    const {
      brand,
      category,
      size,
      condition,
      purchase_cost,
      status,
      box_number
    } = req.body;

    const result = await pool.query(
      `INSERT INTO items 
        (brand, category, size, condition, purchase_cost, status, box_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [brand, category, size, condition, purchase_cost || null, status || 'DRAFT', box_number || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create item', details: err.message });
  }
});

// UPDATE an item's status
app.patch('/api/items/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET status = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item', details: err.message });
  }
});

// UPLOAD image(s) for a specific item
app.post('/api/items/:itemId/images', upload.array('photos', 6), async (req, res) => {
  try {
    const { itemId } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const insertedImages = [];

    for (const file of req.files) {
      let finalFilename = file.filename;
      const isHeic = /\.heic$/i.test(file.originalname) || /\.heif$/i.test(file.originalname) || file.mimetype === 'image/heic' || file.mimetype === 'image/heif';

      if (isHeic) {
        const inputBuffer = fs.readFileSync(file.path);
        const outputBuffer = await heicConvert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.9
        });

        // Save as a new .jpg file alongside, then remove the original .heic
        const jpgFilename = file.filename.replace(/\.[^.]+$/, '') + '.jpg';
        const jpgPath = path.join(path.dirname(file.path), jpgFilename);
        fs.writeFileSync(jpgPath, outputBuffer);
        fs.unlinkSync(file.path);

        finalFilename = jpgFilename;
      }

      const objectKey = `uploads/${itemId}/${finalFilename}`;
      const result = await pool.query(
        `INSERT INTO images (item_id, object_key, image_type)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [itemId, objectKey, 'general']
      );
      insertedImages.push(result.rows[0]);
    }

    res.status(201).json(insertedImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload images', details: err.message });
  }
});
// ANALYZE photos with AI - returns suggested item attributes (does not save)
app.post('/api/analyze-photos', uploadTemp.array('photos', 6), async (req, res) => {  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    // Convert uploaded images to base64 for Claude (converting HEIC to JPEG first if needed)
    const imageBlocks = await Promise.all(req.files.map(async (file) => {
      const isHeic = /\.heic$/i.test(file.originalname) || /\.heif$/i.test(file.originalname) || file.mimetype === 'image/heic' || file.mimetype === 'image/heif';

      let fileBuffer = fs.readFileSync(file.path);
      let mediaType = file.mimetype;

      if (isHeic) {
        const outputBuffer = await heicConvert({
          buffer: fileBuffer,
          format: 'JPEG',
          quality: 0.9
        });
        fileBuffer = outputBuffer;
        mediaType = 'image/jpeg';
      }

      const base64Image = fileBuffer.toString('base64');
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: base64Image
        }
      };
    }));

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            {
              type: 'text',
              text: `You are analyzing photos of a second-hand clothing item for a reselling inventory system. 
Look at all the provided photos (which may include front, back, brand label, size label, etc.) and extract the following information.

Respond ONLY with valid JSON, no other text, no markdown formatting, in exactly this structure:
{
  "brand": "string or null",
  "category": "string or null (e.g. Hoodie, T-Shirt, Jeans, Jacket)",
  "department": "string or null (Men, Women, Kids, Unisex)",
  "size": "string or null",
  "colour": "string or null",
  "material": "string or null",
  "condition": "string or null (Like New, Very Good, Good, Fair)",
  "visible_defects": "string or null (describe any visible defects, or null if none seen)",
  "confidence_notes": "string (brief note on which fields you are unsure about)"
}

If you cannot determine a field from the photos, use null for that field. Do not guess brand names if no logo or label is visible - use null instead.`
            }
          ]
        }
      ]
    });

    const responseText = message.content[0].text;
    
    // Clean up the temporary uploaded files since we don't need to keep them from this analysis step
    req.files.forEach(file => {
      fs.unlink(file.path, (err) => {
        if (err) console.error('Failed to clean up temp file:', err.message);
      });
    });

    // Strip markdown code fences if Claude wrapped the JSON in them
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    }

    let parsedData;
    try {
      parsedData = JSON.parse(cleanedText);
    } catch (parseErr) {
      console.error('Failed to parse AI response as JSON:', responseText);
      return res.status(500).json({ error: 'AI returned invalid format', raw: responseText });
    }

    res.json(parsedData);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to analyze photos', details: err.message });
  }
});
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
