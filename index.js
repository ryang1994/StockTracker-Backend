const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const heicConvert = require('heic-convert');
const sharp = require('sharp');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

app.get('/', (req, res) => {
  res.json({ message: 'Stock Tracker backend is running!' });
});

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
// Archived items (permanent historical record) with profit summary
app.get('/api/archive', async (req, res) => {
  try {
    const archivedResult = await pool.query(
      `SELECT id, brand, category, size, colour, condition, purchase_cost, 
              sold_price, listing_price, date_sold, date_dispatched, date_archived, 
              thumbnail_key, box_number
       FROM items 
       WHERE status = 'ARCHIVED'
       ORDER BY date_archived DESC`
    );

    const items = archivedResult.rows.map(item => {
      const profit = (item.sold_price != null && item.purchase_cost != null)
        ? parseFloat(item.sold_price) - parseFloat(item.purchase_cost)
        : null;
      return { ...item, profit };
    });

    const totalRevenue = items.reduce((sum, i) => sum + (i.sold_price ? parseFloat(i.sold_price) : 0), 0);
    const totalCost = items.reduce((sum, i) => sum + (i.purchase_cost ? parseFloat(i.purchase_cost) : 0), 0);
    const totalProfit = totalRevenue - totalCost;

    res.json({
      items,
      summary: {
        totalItems: items.length,
        totalRevenue,
        totalCost,
        totalProfit
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch archive', details: err.message });
  }
});
// Dashboard summary stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalResult = await pool.query('SELECT COUNT(*) FROM items');

    const sellingResult = await pool.query(
      `SELECT COUNT(*), COALESCE(SUM(listing_price), 0) as total_listing_value 
       FROM items WHERE status IN ('ACTIVE', 'LISTED')`
    );

    const attentionResult = await pool.query(
      `SELECT COUNT(*) FROM items 
       WHERE status NOT IN ('SOLD', 'DISPATCHED', 'ARCHIVED') 
       AND created_at < NOW() - INTERVAL '90 days'`
    );

    res.json({
      totalItems: parseInt(totalResult.rows[0].count),
      selling: parseInt(sellingResult.rows[0].count),
      listedValue: parseFloat(sellingResult.rows[0].total_listing_value),
      needAttention: parseInt(attentionResult.rows[0].count)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats', details: err.message });
  }
});

// GET all items (including their images)
app.get('/api/items', async (req, res) => {
  try {
    // Auto-archive items that have been dispatched 14+ days ago
    const toArchiveResult = await pool.query(
      `SELECT id FROM items 
       WHERE status = 'DISPATCHED' 
       AND date_dispatched < NOW() - INTERVAL '14 days'`
    );

    for (const row of toArchiveResult.rows) {
      const itemImages = await pool.query(
        'SELECT * FROM images WHERE item_id = $1 AND is_deleted = FALSE',
        [row.id]
      );

      if (itemImages.rows.length > 0) {
        const keepImage = itemImages.rows[0];

        // Delete all other images for this item from disk and mark them deleted
        for (const img of itemImages.rows.slice(1)) {
          const filePath = path.join(__dirname, img.object_key);
          fs.unlink(filePath, (err) => {
            if (err) console.error('Failed to delete archived image file:', filePath, err.message);
          });
          await pool.query('UPDATE images SET is_deleted = TRUE WHERE id = $1', [img.id]);
        }

        // Generate a genuine small thumbnail from the one photo we're keeping,
        // then delete the full-resolution original so archived stock doesn't
        // keep taking up full-size disk space forever.
        const keepImagePath = path.join(__dirname, keepImage.object_key);
        let thumbnailKey = keepImage.object_key;

        try {
          const thumbFilename = `thumb-${path.basename(keepImage.object_key, path.extname(keepImage.object_key))}.jpg`;
          const thumbRelativePath = path.join('uploads', String(row.id), thumbFilename).replace(/\\/g, '/');
          const thumbFullPath = path.join(__dirname, thumbRelativePath);

          await sharp(keepImagePath)
            .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(thumbFullPath);

          fs.unlink(keepImagePath, (err) => {
            if (err) console.error('Failed to delete full-res image after thumbnailing:', keepImagePath, err.message);
          });

          await pool.query('UPDATE images SET is_deleted = TRUE WHERE id = $1', [keepImage.id]);

          thumbnailKey = thumbRelativePath;
        } catch (thumbErr) {
          // If thumbnailing fails for any reason, fall back to the old behaviour
          // (keep the full-size file) rather than losing the image entirely.
          console.error('Failed to generate thumbnail, keeping full-size image instead:', thumbErr.message);
        }

        await pool.query(
          `UPDATE items SET status = 'ARCHIVED', date_archived = NOW(), thumbnail_key = $1 WHERE id = $2`,
          [thumbnailKey, row.id]
        );
      } else {
        await pool.query(
          `UPDATE items SET status = 'ARCHIVED', date_archived = NOW() WHERE id = $1`,
          [row.id]
        );
      }
    }

    const itemsResult = await pool.query(
      `SELECT *,
        EXTRACT(DAY FROM NOW() - created_at)::int AS days_held,
        CASE WHEN date_sold IS NOT NULL 
             THEN EXTRACT(DAY FROM date_sold - created_at)::int 
             ELSE NULL END AS days_to_sell,
        CASE WHEN date_dispatched IS NOT NULL 
             THEN EXTRACT(DAY FROM NOW() - date_dispatched)::int 
             ELSE NULL END AS days_since_dispatch,
        (status NOT IN ('SOLD', 'DISPATCHED', 'ARCHIVED') AND created_at < NOW() - INTERVAL '90 days') AS needs_attention
       FROM items 
       ORDER BY created_at DESC`
    );

    const imagesResult = await pool.query(
      'SELECT * FROM images WHERE is_deleted = FALSE ORDER BY created_at ASC'
    );

    const generateDescription = (item) => {
      const parts = [];
      if (item.department) parts.push(item.department + "'s");
      if (item.brand) parts.push(item.brand);
      if (item.colour) parts.push(item.colour);
      if (item.style) parts.push(item.style);
      if (item.category) parts.push(item.category);
      let title = parts.join(' ') || 'Item';

      let detailBits = [];
      if (item.size) detailBits.push(`Size ${item.size}`);
      if (item.outer_shell_material || item.material) detailBits.push(item.outer_shell_material || item.material);
      let detailLine = detailBits.length > 0 ? detailBits.join(', ') + '. ' : '';

      let conditionLine = item.condition ? `${item.condition} pre-owned condition. ` : '';

      let defectsLine = item.visible_defects ? `Note: ${item.visible_defects}. ` : '';

      return `${title}. ${detailLine}${conditionLine}${defectsLine}Please see photos for full details.`.trim();
    };

    const itemsWithImages = itemsResult.rows.map(item => ({
      ...item,
      images: imagesResult.rows.filter(img => img.item_id === item.id),
      generated_description: generateDescription(item)
    }));

    res.json(itemsWithImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch items', details: err.message });
  }
});
// Open the item's photo folder in Windows Explorer (local dev convenience only)
app.post('/api/items/:id/open-folder', (req, res) => {
  try {
    const { id } = req.params;
    const folderPath = path.join(__dirname, 'uploads', String(id));

    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: 'Folder does not exist yet' });
    }

    const { exec } = require('child_process');
    exec(`explorer "${folderPath}"`, (err) => {
      // explorer.exe often returns a non-zero exit code even on success, so we don't treat this as fatal
    });

    res.json({ message: 'Folder opened' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to open folder', details: err.message });
  }
});

// CREATE a new item
app.post('/api/items', async (req, res) => {
  try {
    const {
      brand,
      category,
      size,
      colour,
      condition,
      material,
      style,
      department,
      outer_shell_material,
      purchase_cost,
      listing_price,
      status,
      box_number
    } = req.body;

    const result = await pool.query(
      `INSERT INTO items 
        (brand, category, size, colour, condition, material, style, department, outer_shell_material, purchase_cost, listing_price, status, box_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [brand, category, size, colour || null, condition, material || null, style || null, department || null, outer_shell_material || null, purchase_cost || null, listing_price || null, status || 'DRAFT', box_number || null]
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

// Mark an item as SOLD with the actual sale price
app.patch('/api/items/:id/sell', async (req, res) => {
  try {
    const { id } = req.params;
    const { sold_price } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET status = 'SOLD', sold_price = $1, date_sold = NOW(), updated_at = NOW()
       WHERE id = $2 
       RETURNING *`,
      [sold_price || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark item as sold', details: err.message });
  }
});

// Mark an item as DISPATCHED
app.patch('/api/items/:id/dispatch', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE items 
       SET status = 'DISPATCHED', date_dispatched = NOW(), updated_at = NOW()
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark item as dispatched', details: err.message });
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
      colour,
      condition,
      material,
      style,
      department,
      outer_shell_material,
      purchase_cost,
      listing_price,
      listing_url,
      box_number
    } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET brand = $1, category = $2, size = $3, colour = $4, condition = $5, material = $6,
           style = $7, department = $8, outer_shell_material = $9,
           purchase_cost = $10, listing_price = $11, box_number = $12, listing_url = $13, updated_at = NOW()
       WHERE id = $14 
       RETURNING *`,
      [brand, category, size, colour || null, condition, material || null, style || null, department || null, outer_shell_material || null, purchase_cost || null, listing_price || null, box_number || null, listing_url || null, id]
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

// DELETE an item (and its images)
app.delete('/api/items/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const imagesResult = await pool.query(
      'SELECT * FROM images WHERE item_id = $1',
      [id]
    );

    const result = await pool.query(
      'DELETE FROM items WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    imagesResult.rows.forEach(img => {
      const filePath = path.join(__dirname, img.object_key);
      fs.unlink(filePath, (err) => {
        if (err) console.error('Failed to delete file:', filePath, err.message);
      });
    });

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
app.post('/api/analyze-photos', uploadTemp.array('photos', 6), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

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

    const promptText = "You are analyzing photos of a second-hand clothing item for a reselling inventory system. Look at all the provided photos (which may include front, back, brand label, size label, care label, etc.) and extract the following information. Respond ONLY with valid JSON, no other text, no markdown formatting, in exactly this structure: { \"brand\": \"string or null\", \"category\": \"string or null (e.g. Hoodie, T-Shirt, Jeans, Jacket)\", \"department\": \"string or null (Men, Women, Kids, Unisex)\", \"size\": \"string or null\", \"colour\": \"string or null\", \"material\": \"string or null\", \"outer_shell_material\": \"string or null (the main fabric composition, e.g. 100% Cotton, Polyester blend - check care labels if visible)\", \"style\": \"string or null (e.g. Pullover, Zip-up, Slim Fit, Regular Fit)\", \"condition\": \"string or null (Like New, Very Good, Good, Fair)\", \"visible_defects\": \"string or null (describe any visible defects, or null if none seen)\", \"confidence_notes\": \"string (brief note on which fields you are unsure about)\" }. If you cannot determine a field from the photos, use null for that field. Do not guess brand names if no logo or label is visible - use null instead.";

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
              text: promptText
            }
          ]
        }
      ]
    });

    const responseText = message.content[0].text;

    req.files.forEach(file => {
      fs.unlink(file.path, (err) => {
        if (err) console.error('Failed to clean up temp file:', err.message);
      });
    });

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
