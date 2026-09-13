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
      `SELECT id, item_number, brand, category, size, colour, condition, purchase_cost, 
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
    const archiveDaysResult = await pool.query("SELECT value FROM app_settings WHERE key = 'archive_after_days'");
    const archiveAfterDays = archiveDaysResult.rows.length > 0 ? parseInt(archiveDaysResult.rows[0].value, 10) : 30;

    // Auto-archive items that have been dispatched long enough ago (configurable in Settings).
    // Items with a return flagged are skipped so their photos aren't destroyed mid-dispute.
    const toArchiveResult = await pool.query(
      `SELECT id FROM items 
       WHERE status = 'DISPATCHED' 
       AND date_dispatched < NOW() - ($1 * INTERVAL '1 day')
       AND return_requested IS NOT TRUE`,
      [archiveAfterDays]
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

    const settingsResult = await pool.query('SELECT * FROM app_settings');
    const appSettings = {};
    settingsResult.rows.forEach(row => { appSettings[row.key] = row.value; });
    const ebayDispatchDays = parseInt(appSettings.ebay_dispatch_days, 10) || 2;
    const vintedDispatchDays = parseInt(appSettings.vinted_dispatch_days, 10) || 3;
    const archiveAfterDaysForDisplay = parseInt(appSettings.archive_after_days, 10) || 30;

    const itemsWithImages = itemsResult.rows.map(item => {
      let dispatchDeadline = null;
      let daysToDispatch = null;

      if (item.status === 'SOLD' && item.date_sold) {
        const dispatchDays = item.sold_platform === 'eBay' ? ebayDispatchDays
          : item.sold_platform === 'Vinted' ? vintedDispatchDays
          : null;

        if (dispatchDays !== null) {
          const soldDate = new Date(item.date_sold);
          const deadline = new Date(soldDate.getTime() + dispatchDays * 24 * 60 * 60 * 1000);
          dispatchDeadline = deadline;
          daysToDispatch = Math.ceil((deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        }
      }

      const daysUntilArchived = item.status === 'DISPATCHED' && item.days_since_dispatch != null
        ? Math.max(0, archiveAfterDaysForDisplay - item.days_since_dispatch)
        : null;

      return {
        ...item,
        images: imagesResult.rows.filter(img => img.item_id === item.id),
        generated_description: generateDescription(item),
        dispatch_deadline: dispatchDeadline,
        days_to_dispatch: daysToDispatch,
        days_until_archived: daysUntilArchived
      };
    });

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
      box_number,
      box_id,
      quantity,
      ebay_estimated_low,
      ebay_estimated_high,
      ebay_estimated_median,
      ebay_estimated_count
    } = req.body;

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const createdItems = [];
    const hasPriceEstimate = ebay_estimated_median !== undefined && ebay_estimated_median !== null;

    for (let i = 0; i < qty; i++) {
      const numResult = await pool.query("SELECT nextval('item_number_seq') AS n");
      const itemNumber = `CL-${String(numResult.rows[0].n).padStart(6, '0')}`;

      const result = await pool.query(
        `INSERT INTO items 
          (item_number, brand, category, size, colour, condition, material, style, department, outer_shell_material, purchase_cost, listing_price, status, box_number, box_id,
           ebay_estimated_low, ebay_estimated_high, ebay_estimated_median, ebay_estimated_count, ebay_price_checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING *`,
        [itemNumber, brand, category, size, colour || null, condition, material || null, style || null, department || null, outer_shell_material || null, purchase_cost || null, listing_price || null, status || 'DRAFT', box_number || null, box_id || null,
         ebay_estimated_low || null, ebay_estimated_high || null, ebay_estimated_median || null, ebay_estimated_count || null, hasPriceEstimate ? new Date().toISOString() : null]
      );

      createdItems.push({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
    }

    res.status(201).json(createdItems);
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

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item', details: err.message });
  }
});

// Mark an item as SOLD with the actual sale price
app.patch('/api/items/:id/sell', async (req, res) => {
  try {
    const { id } = req.params;
    const { sold_price, selling_fees, sold_platform } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET status = 'SOLD', sold_price = $1, selling_fees = $2, sold_platform = $3, date_sold = NOW(), updated_at = NOW()
       WHERE id = $4 
       RETURNING *`,
      [sold_price || null, selling_fees || 0, sold_platform || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
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

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark item as dispatched', details: err.message });
  }
});

// Flag: buyer has requested a return - doesn't touch the sale, just marks it for visibility
app.patch('/api/items/:id/flag-return', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE items SET return_requested = TRUE, return_requested_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to flag return', details: err.message });
  }
});

// Cancel a flagged return - the complaint resolved without an actual physical return
app.patch('/api/items/:id/unflag-return', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE items SET return_requested = FALSE, return_requested_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel return flag', details: err.message });
  }
});

// Return: item came back from a buyer, undo the sale and put it back to DRAFT to relist
app.patch('/api/items/:id/return', async (req, res) => {
  try {
    const { id } = req.params;

    // Capture the sale details before wiping them, so return history isn't lost
    const beforeResult = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    if (beforeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const before = beforeResult.rows[0];

    await pool.query(
      `INSERT INTO returns_log 
        (item_id, item_number, brand, category, sold_price, selling_fees, sold_platform, date_sold, date_dispatched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [before.id, before.item_number, before.brand, before.category, before.sold_price, before.selling_fees, before.sold_platform, before.date_sold, before.date_dispatched]
    );

    const result = await pool.query(
      `UPDATE items 
       SET status = 'DRAFT', 
           sold_price = NULL, 
           selling_fees = 0, 
           sold_platform = NULL, 
           date_sold = NULL, 
           date_dispatched = NULL, 
           return_requested = FALSE,
           return_requested_at = NULL,
           updated_at = NOW()
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process return', details: err.message });
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
      box_number,
      box_id,
      ebay_url,
      vinted_url
    } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET brand = $1, category = $2, size = $3, colour = $4, condition = $5, material = $6,
           style = $7, department = $8, outer_shell_material = $9,
           purchase_cost = $10, listing_price = $11, box_number = $12, listing_url = $13,
           box_id = $14, ebay_url = $15, vinted_url = $16, updated_at = NOW()
       WHERE id = $17 
       RETURNING *`,
      [brand, category, size, colour || null, condition, material || null, style || null, department || null, outer_shell_material || null, purchase_cost || null, listing_price || null, box_number || null, listing_url || null, box_id || null, ebay_url || null, vinted_url || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
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

// Configure multer for bookkeeping receipt photos (mileage + expenses)
const receiptStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'receipts');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const uploadReceipt = multer({
  storage: receiptStorage,
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

// ===================== BOOKKEEPING =====================

// UK tax year runs 6 April - 5 April. "startYear" of 2026 means the 2026/27 tax year.
function getTaxYearBounds(startYear) {
  const start = new Date(Date.UTC(startYear, 3, 6, 0, 0, 0));
  const end = new Date(Date.UTC(startYear + 1, 3, 5, 23, 59, 59));
  return { start, end };
}

function generateDescription(item) {
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
}

function getCurrentTaxYearStartYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const aprSixThisYear = new Date(Date.UTC(year, 3, 6, 0, 0, 0));
  return now >= aprSixThisYear ? year : year - 1;
}

// Registration deadline: 5 Oct following the tax year end. Filing/payment: 31 Jan the year after that.
function getSelfAssessmentDeadlines(startYear) {
  const registrationDeadline = new Date(Date.UTC(startYear + 1, 9, 5));
  const filingPaymentDeadline = new Date(Date.UTC(startYear + 2, 0, 31));
  return { registrationDeadline, filingPaymentDeadline };
}

async function getSetting(key, fallback) {
  const result = await pool.query('SELECT value FROM bookkeeping_settings WHERE key = $1', [key]);
  return result.rows.length > 0 ? result.rows[0].value : fallback;
}

// Income Tax + Class 4 NI on the business profit only, given existing employment income.
// Since this is side income, the Personal Allowance is assumed already used by employment income.
function calculateTax(profit, employmentIncome) {
  const BASIC_RATE_LIMIT = 50270;
  const HIGHER_RATE_LIMIT = 125140;

  const combinedIncome = employmentIncome + profit;

  // Income Tax: split the profit itself across whichever bands it spans,
  // starting from wherever employment income has already reached.
  let incomeTax = 0;
  let remainingProfit = profit;
  let bandFloor = employmentIncome;

  const bands = [
    { limit: BASIC_RATE_LIMIT, rate: 0.20 },
    { limit: HIGHER_RATE_LIMIT, rate: 0.40 },
    { limit: Infinity, rate: 0.45 }
  ];

  for (const band of bands) {
    if (remainingProfit <= 0) break;
    if (bandFloor >= band.limit) continue;
    const spaceInBand = band.limit - bandFloor;
    const amountInBand = Math.min(remainingProfit, spaceInBand);
    incomeTax += amountInBand * band.rate;
    remainingProfit -= amountInBand;
    bandFloor += amountInBand;
  }

  // Class 4 NI: based purely on this business's own profit, own £12,570 threshold,
  // independent of employment income.
  const NI_LOWER = 12570;
  const NI_UPPER = 50270;
  let ni = 0;
  if (profit > NI_LOWER) {
    const inMainBand = Math.min(profit, NI_UPPER) - NI_LOWER;
    ni += Math.max(0, inMainBand) * 0.06;
    if (profit > NI_UPPER) {
      ni += (profit - NI_UPPER) * 0.02;
    }
  }

  return {
    combinedIncome,
    incomeTax: Math.round(incomeTax * 100) / 100,
    classFourNI: Math.round(ni * 100) / 100,
    totalEstimatedTax: Math.round((incomeTax + ni) * 100) / 100,
    higherRateThreshold: BASIC_RATE_LIMIT,
    headroomToHigherRate: Math.round((BASIC_RATE_LIMIT - combinedIncome) * 100) / 100
  };
}

// Settings: mileage rate is a global default for new entries.
// Employment income and amount-set-aside are per tax year, so past years never get silently rewritten.
app.get('/api/bookkeeping/settings', async (req, res) => {
  try {
    const mileageRate = await getSetting('mileage_rate_pence', '55');
    res.json({ mileage_rate_pence: parseInt(mileageRate, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/bookkeeping/settings', async (req, res) => {
  try {
    const { mileage_rate_pence } = req.body;
    if (mileage_rate_pence !== undefined) {
      await pool.query(
        `INSERT INTO bookkeeping_settings (key, value) VALUES ('mileage_rate_pence', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(mileage_rate_pence)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Per-tax-year settings: employment income and amount already set aside for tax
app.get('/api/bookkeeping/tax-year-settings/:startYear', async (req, res) => {
  try {
    const startYear = parseInt(req.params.startYear, 10);
    const result = await pool.query('SELECT * FROM tax_year_settings WHERE start_year = $1', [startYear]);

    if (result.rows.length > 0) {
      return res.json(result.rows[0]);
    }

    // No saved row for this year yet - default employment income to the most recent prior year's value
    const priorResult = await pool.query(
      'SELECT employment_income FROM tax_year_settings WHERE start_year < $1 ORDER BY start_year DESC LIMIT 1',
      [startYear]
    );
    const defaultIncome = priorResult.rows.length > 0 ? priorResult.rows[0].employment_income : 0;

    res.json({ start_year: startYear, employment_income: defaultIncome, amount_set_aside: 0, unsaved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tax year settings' });
  }
});

app.put('/api/bookkeeping/tax-year-settings/:startYear', async (req, res) => {
  try {
    const startYear = parseInt(req.params.startYear, 10);
    const { employment_income, amount_set_aside } = req.body;

    const result = await pool.query(
      `INSERT INTO tax_year_settings (start_year, employment_income, amount_set_aside)
       VALUES ($1, $2, $3)
       ON CONFLICT (start_year) DO UPDATE SET employment_income = $2, amount_set_aside = $3
       RETURNING *`,
      [startYear, employment_income || 0, amount_set_aside || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tax year settings' });
  }
});

// List available tax years (from earliest recorded activity through the current tax year)
app.get('/api/bookkeeping/tax-years', async (req, res) => {
  try {
    const currentStartYear = getCurrentTaxYearStartYear();

    const earliestResult = await pool.query(`
      SELECT MIN(d) AS earliest FROM (
        SELECT created_at::date AS d FROM items
        UNION ALL SELECT trip_date::date AS d FROM mileage_log
        UNION ALL SELECT expense_date::date AS d FROM expenses
      ) all_dates
    `);

    let earliestStartYear = currentStartYear;
    if (earliestResult.rows[0].earliest) {
      const earliestDate = new Date(earliestResult.rows[0].earliest);
      const y = earliestDate.getUTCFullYear();
      const aprSix = new Date(Date.UTC(y, 3, 6));
      earliestStartYear = earliestDate >= aprSix ? y : y - 1;
    }

    const years = [];
    for (let y = currentStartYear; y >= earliestStartYear; y--) {
      years.push({ startYear: y, label: `${y}/${String(y + 1).slice(2)}` });
    }
    res.json(years);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tax years' });
  }
});

// Mileage log
app.get('/api/mileage', async (req, res) => {
  try {
    const startYear = parseInt(req.query.taxYear, 10) || getCurrentTaxYearStartYear();
    const { start, end } = getTaxYearBounds(startYear);
    const result = await pool.query(
      `SELECT * FROM mileage_log WHERE trip_date >= $1 AND trip_date <= $2 ORDER BY trip_date DESC`,
      [start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch mileage log' });
  }
});

app.post('/api/mileage', uploadReceipt.single('receipt'), async (req, res) => {
  try {
    const { trip_date, purpose, miles, notes } = req.body;
    const ratePence = parseInt(await getSetting('mileage_rate_pence', '55'), 10);
    const calculatedCost = (parseFloat(miles) * ratePence) / 100;
    const receiptKey = req.file ? `uploads/receipts/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO mileage_log (trip_date, purpose, miles, rate_pence, calculated_cost, receipt_key, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [trip_date, purpose, miles, ratePence, calculatedCost, receiptKey, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log mileage' });
  }
});

app.delete('/api/mileage/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mileage_log WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const entry = result.rows[0];
    if (entry.receipt_key) {
      const filePath = path.join(__dirname, entry.receipt_key);
      fs.unlink(filePath, (err) => {
        if (err) console.error('Failed to delete receipt file:', filePath, err.message);
      });
    }
    await pool.query('DELETE FROM mileage_log WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete mileage entry' });
  }
});

// General expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const startYear = parseInt(req.query.taxYear, 10) || getCurrentTaxYearStartYear();
    const { start, end } = getTaxYearBounds(startYear);
    const result = await pool.query(
      `SELECT * FROM expenses WHERE expense_date >= $1 AND expense_date <= $2 ORDER BY expense_date DESC`,
      [start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

app.post('/api/expenses', uploadReceipt.single('receipt'), async (req, res) => {
  try {
    const { expense_date, category, description, amount, notes } = req.body;
    const receiptKey = req.file ? `uploads/receipts/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO expenses (expense_date, category, description, amount, receipt_key, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [expense_date, category, description, amount, receiptKey, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add expense' });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const entry = result.rows[0];
    if (entry.receipt_key) {
      const filePath = path.join(__dirname, entry.receipt_key);
      fs.unlink(filePath, (err) => {
        if (err) console.error('Failed to delete receipt file:', filePath, err.message);
      });
    }
    await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// Full bookkeeping summary for a given tax year
app.get('/api/bookkeeping/summary', async (req, res) => {
  try {
    const startYear = parseInt(req.query.taxYear, 10) || getCurrentTaxYearStartYear();
    const { start, end } = getTaxYearBounds(startYear);

    // Turnover: items actually sold within this tax year
    const turnoverResult = await pool.query(
      `SELECT COALESCE(SUM(sold_price), 0) AS total, COALESCE(SUM(selling_fees), 0) AS fees FROM items
       WHERE status IN ('SOLD', 'DISPATCHED', 'ARCHIVED') AND date_sold >= $1 AND date_sold <= $2`,
      [start, end]
    );
    const turnover = parseFloat(turnoverResult.rows[0].total);
    const marketplaceFees = parseFloat(turnoverResult.rows[0].fees);

    // Stock cost: cash basis - counted when the item entered the system, not when sold
    const stockCostResult = await pool.query(
      `SELECT COALESCE(SUM(purchase_cost), 0) AS total, COUNT(*) FILTER (WHERE purchase_receipt_key IS NOT NULL) AS receipts FROM items
       WHERE created_at >= $1 AND created_at <= $2`,
      [start, end]
    );
    const stockCost = parseFloat(stockCostResult.rows[0].total);
    const stockReceipts = parseInt(stockCostResult.rows[0].receipts, 10);

    const mileageResult = await pool.query(
      `SELECT COALESCE(SUM(calculated_cost), 0) AS total, COUNT(*) FILTER (WHERE receipt_key IS NOT NULL) AS receipts
       FROM mileage_log WHERE trip_date >= $1 AND trip_date <= $2`,
      [start, end]
    );
    const mileageCost = parseFloat(mileageResult.rows[0].total);
    const mileageReceipts = parseInt(mileageResult.rows[0].receipts, 10);

    const expensesResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) FILTER (WHERE receipt_key IS NOT NULL) AS receipts
       FROM expenses WHERE expense_date >= $1 AND expense_date <= $2`,
      [start, end]
    );
    const otherExpenses = parseFloat(expensesResult.rows[0].total);
    const expenseReceipts = parseInt(expensesResult.rows[0].receipts, 10);

    const totalExpenses = stockCost + mileageCost + otherExpenses + marketplaceFees;
    const profit = turnover - totalExpenses;

    // Per-tax-year employment income / amount already set aside
    const settingsResult = await pool.query('SELECT * FROM tax_year_settings WHERE start_year = $1', [startYear]);
    let employmentIncome = 0;
    let amountSetAside = 0;
    if (settingsResult.rows.length > 0) {
      employmentIncome = parseFloat(settingsResult.rows[0].employment_income);
      amountSetAside = parseFloat(settingsResult.rows[0].amount_set_aside);
    } else {
      const priorResult = await pool.query(
        'SELECT employment_income FROM tax_year_settings WHERE start_year < $1 ORDER BY start_year DESC LIMIT 1',
        [startYear]
      );
      employmentIncome = priorResult.rows.length > 0 ? parseFloat(priorResult.rows[0].employment_income) : 0;
    }

    const TRADING_ALLOWANCE = 1000;
    let taxBreakdown = null;
    let coveredByTradingAllowance = false;

    if (turnover <= TRADING_ALLOWANCE) {
      coveredByTradingAllowance = true;
    } else if (profit > 0) {
      taxBreakdown = calculateTax(profit, employmentIncome);
    }

    const deadlines = getSelfAssessmentDeadlines(startYear);

    const returnsResult = await pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(sold_price), 0) AS total
       FROM returns_log WHERE returned_at >= $1 AND returned_at <= $2`,
      [start, end]
    );
    const returnsCount = parseInt(returnsResult.rows[0].count, 10);
    const returnsValue = parseFloat(returnsResult.rows[0].total);

    res.json({
      taxYear: { startYear, label: `${startYear}/${String(startYear + 1).slice(2)}` },
      turnover,
      stockCost,
      mileageCost,
      otherExpenses,
      marketplaceFees,
      totalExpenses,
      profit,
      employmentIncome,
      amountSetAside,
      coveredByTradingAllowance,
      tradingAllowance: TRADING_ALLOWANCE,
      tax: taxBreakdown,
      receiptsRecorded: stockReceipts + mileageReceipts + expenseReceipts,
      returnsCount,
      returnsValue,
      deadlines: {
        registration: deadlines.registrationDeadline,
        filingAndPayment: deadlines.filingPaymentDeadline
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate bookkeeping summary' });
  }
});

// CSV export of everything for a tax year - sales, mileage, expenses
app.get('/api/bookkeeping/export', async (req, res) => {
  try {
    const startYear = parseInt(req.query.taxYear, 10) || getCurrentTaxYearStartYear();
    const { start, end } = getTaxYearBounds(startYear);
    const label = `${startYear}-${startYear + 1}`;

    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    let csv = `StockTracker Bookkeeping Export - Tax Year ${label}\n\n`;

    csv += 'SALES\n';
    csv += 'Item Number,Date Sold,Brand,Category,Purchase Cost,Has Purchase Receipt,Sold Price,Marketplace Fees,Net Profit\n';
    const salesResult = await pool.query(
      `SELECT item_number, date_sold, brand, category, purchase_cost, purchase_receipt_key, sold_price, selling_fees FROM items
       WHERE status IN ('SOLD', 'DISPATCHED', 'ARCHIVED') AND date_sold >= $1 AND date_sold <= $2
       ORDER BY date_sold ASC`,
      [start, end]
    );
    for (const row of salesResult.rows) {
      const netProfit = parseFloat(row.sold_price || 0) - parseFloat(row.purchase_cost || 0) - parseFloat(row.selling_fees || 0);
      csv += [
        csvEscape(row.item_number),
        new Date(row.date_sold).toLocaleDateString('en-GB'),
        csvEscape(row.brand),
        csvEscape(row.category),
        parseFloat(row.purchase_cost || 0).toFixed(2),
        row.purchase_receipt_key ? 'Yes' : 'No',
        parseFloat(row.sold_price || 0).toFixed(2),
        parseFloat(row.selling_fees || 0).toFixed(2),
        netProfit.toFixed(2)
      ].join(',') + '\n';
    }

    csv += '\nMILEAGE\n';
    csv += 'Date,Purpose,Miles,Rate (pence),Cost,Notes,Has Receipt\n';
    const mileageResult = await pool.query(
      `SELECT * FROM mileage_log WHERE trip_date >= $1 AND trip_date <= $2 ORDER BY trip_date ASC`,
      [start, end]
    );
    for (const row of mileageResult.rows) {
      csv += [
        new Date(row.trip_date).toLocaleDateString('en-GB'),
        csvEscape(row.purpose),
        row.miles,
        row.rate_pence,
        parseFloat(row.calculated_cost).toFixed(2),
        csvEscape(row.notes),
        row.receipt_key ? 'Yes' : 'No'
      ].join(',') + '\n';
    }

    csv += '\nEXPENSES\n';
    csv += 'Date,Category,Description,Amount,Notes,Has Receipt\n';
    const expensesResult = await pool.query(
      `SELECT * FROM expenses WHERE expense_date >= $1 AND expense_date <= $2 ORDER BY expense_date ASC`,
      [start, end]
    );
    for (const row of expensesResult.rows) {
      csv += [
        new Date(row.expense_date).toLocaleDateString('en-GB'),
        csvEscape(row.category),
        csvEscape(row.description),
        parseFloat(row.amount).toFixed(2),
        csvEscape(row.notes),
        row.receipt_key ? 'Yes' : 'No'
      ].join(',') + '\n';
    }

    csv += '\nRETURNS (sales that were refunded and removed from turnover above)\n';
    csv += 'Item Number,Brand,Category,Original Sale Price,Marketplace Fees,Sold Via,Date Sold,Date Dispatched,Date Returned\n';
    const returnsResult = await pool.query(
      `SELECT * FROM returns_log WHERE returned_at >= $1 AND returned_at <= $2 ORDER BY returned_at ASC`,
      [start, end]
    );
    for (const row of returnsResult.rows) {
      csv += [
        csvEscape(row.item_number),
        csvEscape(row.brand),
        csvEscape(row.category),
        parseFloat(row.sold_price || 0).toFixed(2),
        parseFloat(row.selling_fees || 0).toFixed(2),
        csvEscape(row.sold_platform),
        row.date_sold ? new Date(row.date_sold).toLocaleDateString('en-GB') : '',
        row.date_dispatched ? new Date(row.date_dispatched).toLocaleDateString('en-GB') : '',
        new Date(row.returned_at).toLocaleDateString('en-GB')
      ].join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="stocktracker-tax-year-${label}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export bookkeeping data' });
  }
});

// Attach a purchase receipt to an item - separate from product photos, never auto-deleted/archived
app.post('/api/items/:id/purchase-receipt', uploadReceipt.single('receipt'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No receipt file provided' });

    const receiptKey = `uploads/receipts/${req.file.filename}`;
    const result = await pool.query(
      `UPDATE items SET purchase_receipt_key = $1 WHERE id = $2 RETURNING *`,
      [receiptKey, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload purchase receipt' });
  }
});

// ===================== BOXES =====================

app.get('/api/boxes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM boxes ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch boxes' });
  }
});

app.post('/api/boxes', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Box name is required' });
    const result = await pool.query('INSERT INTO boxes (name) VALUES ($1) RETURNING *', [name.trim()]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create box' });
  }
});

app.put('/api/boxes/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Box name is required' });
    const result = await pool.query('UPDATE boxes SET name = $1 WHERE id = $2 RETURNING *', [name.trim(), req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Box not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to rename box' });
  }
});

app.delete('/api/boxes/:id', async (req, res) => {
  try {
    const inUse = await pool.query('SELECT COUNT(*) FROM items WHERE box_id = $1', [req.params.id]);
    if (parseInt(inUse.rows[0].count, 10) > 0) {
      return res.status(400).json({ error: 'Cannot delete a box that still has items assigned to it' });
    }
    await pool.query('DELETE FROM boxes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete box' });
  }
});

// ===================== APP SETTINGS (backup status, dispatch presets, eBay/Vinted placeholders) =====================

app.get('/api/settings/app', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM app_settings');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch app settings' });
  }
});

app.put('/api/settings/app', async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, String(value)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update app settings' });
  }
});

// Live check: is the Claude API key actually valid right now? Uses the free count_tokens
// endpoint, which costs nothing and doesn't generate a completion - just tests auth.
app.get('/api/settings/ai-status', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ active: false, reason: 'No API key configured' });
    }
    await anthropic.messages.countTokens({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'ping' }]
    });
    res.json({ active: true });
  } catch (err) {
    console.error('AI status check failed:', err.message);
    res.json({ active: false, reason: err.message });
  }
});

// ===================== EBAY OAUTH INTEGRATION =====================

const EBAY_ENV = process.env.EBAY_ENVIRONMENT || 'sandbox'; // 'sandbox' or 'production'
const EBAY_AUTH_BASE = EBAY_ENV === 'production' ? 'https://auth.ebay.com' : 'https://auth.sandbox.ebay.com';
const EBAY_API_BASE = EBAY_ENV === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account'
].join(' ');

function getEbayBasicAuthHeader() {
  const credentials = `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

// Step 1: send the user to eBay's consent page
app.get('/api/ebay/connect', (req, res) => {
  if (!process.env.EBAY_APP_ID || !process.env.EBAY_RUNAME) {
    return res.status(500).send('eBay credentials are not configured on the server yet.');
  }

  const params = new URLSearchParams({
    client_id: process.env.EBAY_APP_ID,
    redirect_uri: process.env.EBAY_RUNAME,
    response_type: 'code',
    scope: EBAY_SCOPES
  });

  res.redirect(`${EBAY_AUTH_BASE}/oauth2/authorize?${params.toString()}`);
});

// Step 2: eBay redirects here with a code - exchange it for tokens automatically
app.get('/api/ebay/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.redirect('https://stocktracker-app.com/?ebay=error');
    }

    const response = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getEbayBasicAuthHeader()
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.EBAY_RUNAME
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('eBay token exchange failed:', data);
      return res.redirect('https://stocktracker-app.com/?ebay=error');
    }

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    const updates = {
      ebay_access_token: data.access_token,
      ebay_refresh_token: data.refresh_token,
      ebay_token_expires_at: expiresAt,
      ebay_connected_at: new Date().toISOString(),
      ebay_active: 'true'
    };

    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, value]
      );
    }

    res.redirect('https://stocktracker-app.com/?ebay=connected');
  } catch (err) {
    console.error('eBay OAuth callback error:', err);
    res.redirect('https://stocktracker-app.com/?ebay=error');
  }
});

app.get('/api/ebay/oauth/declined', (req, res) => {
  res.redirect('https://stocktracker-app.com/?ebay=declined');
});

// Automatically refreshes the access token using the refresh token if it's expired or close to it
async function getValidEbayAccessToken() {
  const settingsResult = await pool.query(
    `SELECT key, value FROM app_settings WHERE key IN ('ebay_access_token', 'ebay_refresh_token', 'ebay_token_expires_at')`
  );
  const settings = {};
  settingsResult.rows.forEach(row => { settings[row.key] = row.value; });

  if (!settings.ebay_refresh_token) {
    throw new Error('eBay is not connected yet');
  }

  const expiresAt = settings.ebay_token_expires_at ? new Date(settings.ebay_token_expires_at) : new Date(0);
  const stillValid = expiresAt.getTime() - Date.now() > 5 * 60 * 1000; // 5 min buffer

  if (stillValid) {
    return settings.ebay_access_token;
  }

  // Refresh it
  const response = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': getEbayBasicAuthHeader()
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: settings.ebay_refresh_token,
      scope: EBAY_SCOPES
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error('Failed to refresh eBay token: ' + JSON.stringify(data));
  }

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ebay_access_token', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [data.access_token]
  );
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ebay_token_expires_at', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [newExpiresAt]
  );

  return data.access_token;
}

// Real connection status for the Settings page - not a manual toggle
// ===================== EBAY PRICE RESEARCH (Browse API, Application token) =====================

// Mints/reuses an Application access token via client credentials grant - always against
// Production, since Sandbox has no real listings to search against.
async function getEbayApplicationToken() {
  const settingsResult = await pool.query(
    `SELECT key, value FROM app_settings WHERE key IN ('ebay_app_token', 'ebay_app_token_expires_at')`
  );
  const settings = {};
  settingsResult.rows.forEach(row => { settings[row.key] = row.value; });

  const expiresAt = settings.ebay_app_token_expires_at ? new Date(settings.ebay_app_token_expires_at) : new Date(0);
  const stillValid = expiresAt.getTime() - Date.now() > 5 * 60 * 1000;

  if (stillValid && settings.ebay_app_token) {
    return settings.ebay_app_token;
  }

  const credentials = `${process.env.EBAY_PROD_APP_ID}:${process.env.EBAY_PROD_CERT_ID}`;
  const basicAuth = 'Basic ' + Buffer.from(credentials).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error('Failed to get eBay application token: ' + JSON.stringify(data));
  }

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ebay_app_token', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [data.access_token]
  );
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ebay_app_token_expires_at', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [newExpiresAt]
  );

  return data.access_token;
}

// Real-time search against live eBay UK listings - read-only, no user account involved
// ===================== EBAY CATEGORY MAPPING (Taxonomy API) =====================
// Uses the same Application token as price research - no new auth needed.

async function getEbayCategoryTreeId() {
  const cached = await pool.query("SELECT value FROM app_settings WHERE key = 'ebay_category_tree_id'");
  if (cached.rows.length > 0) return cached.rows[0].value;

  const token = await getEbayApplicationToken();
  const response = await fetch('https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_GB', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Failed to get category tree id: ' + JSON.stringify(data));

  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ebay_category_tree_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [data.categoryTreeId]
  );
  return data.categoryTreeId;
}

// Suggests real eBay categories based on a text search - e.g. brand + category
app.get('/api/ebay/category-suggestions', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'A search query is required' });
    }

    const token = await getEbayApplicationToken();
    const treeId = await getEbayCategoryTreeId();

    const params = new URLSearchParams({ q: q.trim() });
    const response = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();

    if (!response.ok) {
      console.error('Category suggestions failed:', data);
      return res.status(502).json({ error: 'Failed to get category suggestions', details: data });
    }

    const suggestions = (data.categorySuggestions || []).map(s => ({
      categoryId: s.category.categoryId,
      categoryName: s.category.categoryName,
      path: (s.categoryTreeNodeAncestors || []).map(a => a.categoryName).reverse().join(' > ')
    }));

    res.json({ suggestions });
  } catch (err) {
    console.error('Category suggestion error:', err);
    res.status(500).json({ error: 'Failed to get category suggestions', details: err.message });
  }
});

// Real, eBay-defined required/recommended fields for a specific category
app.get('/api/ebay/item-aspects', async (req, res) => {
  try {
    const { category_id } = req.query;
    if (!category_id) {
      return res.status(400).json({ error: 'category_id is required' });
    }

    const token = await getEbayApplicationToken();
    const treeId = await getEbayCategoryTreeId();

    const response = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${category_id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();

    if (!response.ok) {
      console.error('Item aspects failed:', data);
      return res.status(502).json({ error: 'Failed to get item aspects', details: data });
    }

    const aspects = (data.aspects || []).map(a => ({
      name: a.localizedAspectName,
      required: a.aspectConstraint && a.aspectConstraint.aspectRequired,
      mode: a.aspectConstraint && a.aspectConstraint.aspectMode,
      values: (a.aspectValues || []).map(v => v.localizedValue).slice(0, 20)
    }));

    res.json({ aspects });
  } catch (err) {
    console.error('Item aspects error:', err);
    res.status(500).json({ error: 'Failed to get item aspects', details: err.message });
  }
});

// Save the chosen eBay category onto an item
// Save confirmed eBay aspect selections (e.g. Colour: "Blue" picked from eBay's controlled list)
app.patch('/api/items/:id/aspects', async (req, res) => {
  try {
    const { id } = req.params;
    const { aspects } = req.body;

    const result = await pool.query(
      `UPDATE items SET ebay_aspects = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [JSON.stringify(aspects || {}), id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save aspects', details: err.message });
  }
});

// Same best-guess logic as the frontend, so the publish payload matches what's actually displayed
function guessValueForAspectServer(aspectName, item) {
  const name = aspectName.toLowerCase();
  if (name.includes('brand')) return item.brand;
  if (name.includes('colour') || name.includes('color')) return item.colour;
  if (name.includes('department')) return item.department;
  if (name.includes('size')) return item.size;
  if (name.includes('style')) return item.style;
  if (name.includes('type')) return item.category;
  if (name.includes('outer shell') || name.includes('material')) return item.outer_shell_material || item.material;
  if (name.includes('condition')) return item.condition;
  return '';
}

function findClosestValueServer(guess, values) {
  if (!guess || !values || values.length === 0) return '';
  const guessLower = guess.toLowerCase();
  const exact = values.find(v => v.toLowerCase() === guessLower);
  if (exact) return exact;
  const partial = values.find(v => guessLower.includes(v.toLowerCase()) || v.toLowerCase().includes(guessLower));
  if (partial) return partial;
  return '';
}

const EBAY_CONDITION_MAP = {
  'Like New': 'LIKE_NEW',
  'Very Good': 'USED_VERY_GOOD',
  'Good': 'USED_GOOD',
  'Fair': 'USED_ACCEPTABLE'
};

// Standard eBay Condition ID -> ConditionEnum mapping, ranked roughly best-to-worst
const CONDITION_ID_TO_ENUM = [
  { id: 2750, enumValue: 'LIKE_NEW' },
  { id: 4000, enumValue: 'USED_VERY_GOOD' },
  { id: 5000, enumValue: 'USED_GOOD' },
  { id: 6000, enumValue: 'USED_ACCEPTABLE' },
  { id: 3000, enumValue: 'USED_EXCELLENT' },
  { id: 1000, enumValue: 'NEW' }
];

// Different eBay categories support different condition sets - check what's actually
// valid here rather than assume our fixed mapping always works, falling back to the
// closest available option if our preferred one isn't supported for this category.
async function getValidConditionForCategory(categoryId, preferredEnum) {
  const token = await getEbayApplicationToken();
  const url = `https://api.ebay.com/sell/metadata/v1/marketplace/EBAY_GB/get_item_condition_policies?filter=categoryIds:{${categoryId}}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();

  console.log('Condition policy check URL:', url);
  console.log('Condition policy check response:', response.status, JSON.stringify(data));

  if (!response.ok || !data.itemConditionPolicies || data.itemConditionPolicies.length === 0) {
    console.log('Condition policy check inconclusive - keeping preferred value:', preferredEnum);
    return preferredEnum;
  }

  const validIds = (data.itemConditionPolicies[0].itemConditions || []).map(c => parseInt(c.conditionId, 10));
  console.log('Valid condition IDs for category', categoryId, ':', validIds);

  const preferredMatch = CONDITION_ID_TO_ENUM.find(c => c.enumValue === preferredEnum);

  if (preferredMatch && validIds.includes(preferredMatch.id)) {
    return preferredEnum;
  }

  const closest = CONDITION_ID_TO_ENUM.find(c => validIds.includes(c.id));
  console.log('Preferred condition not valid, falling back to:', closest ? closest.enumValue : preferredEnum);
  return closest ? closest.enumValue : preferredEnum;
}

// The actual publish sequence: createOrReplaceInventoryItem -> createOffer -> publishOffer
// Simple verification tool - visit this URL directly in a browser to see the real,
// current status of an item's eBay listing straight from eBay's API, bypassing
// eBay's own Sandbox dashboard entirely (which is known to be unreliable).
app.get('/api/items/:id/ebay-status', async (req, res) => {
  try {
    const { id } = req.params;
    const itemResult = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    const item = itemResult.rows[0];

    if (!item.ebay_offer_id) {
      return res.json({ hasOffer: false, message: 'This item has no eBay offer on record yet.' });
    }

    const token = await getValidEbayAccessToken();
    const response = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/${item.ebay_offer_id}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Language': 'en-GB',
        'Accept-Language': 'en-GB'
      }
    });
    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({ error: 'Could not fetch offer status from eBay', details: data });
    }

    res.json({
      hasOffer: true,
      itemNumber: item.item_number,
      offerId: item.ebay_offer_id,
      storedListingId: item.ebay_listing_id,
      ebayStatus: data.status,
      ebayListing: data.listing,
      fullResponse: data
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check eBay status', details: err.message });
  }
});

app.post('/api/items/:id/publish-ebay', async (req, res) => {
  try {
    const { id } = req.params;

    const itemResult = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    const item = itemResult.rows[0];

    const imagesResult = await pool.query('SELECT * FROM images WHERE item_id = $1 AND is_deleted = FALSE ORDER BY created_at ASC', [id]);
    const images = imagesResult.rows;

    // --- Pre-flight checks ---
    if (!item.ebay_category_id) {
      return res.status(400).json({ error: 'This item needs an eBay category selected first.' });
    }
    if (images.length === 0) {
      return res.status(400).json({ error: 'This item needs at least one photo.' });
    }
    if (!item.listing_price) {
      return res.status(400).json({ error: 'This item needs a listing price.' });
    }

    const settingsResult = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('ebay_fulfillment_policy_id', 'ebay_return_policy_id', 'ebay_payment_policy_id', 'ebay_merchant_location_key')`
    );
    const settings = {};
    settingsResult.rows.forEach(row => { settings[row.key] = row.value; });

    if (!settings.ebay_fulfillment_policy_id || !settings.ebay_return_policy_id || !settings.ebay_payment_policy_id) {
      return res.status(400).json({ error: 'Business Policies need to be set up in Settings before publishing.' });
    }
    if (!settings.ebay_merchant_location_key) {
      return res.status(400).json({ error: 'An inventory location needs to be set up in Settings before publishing.' });
    }

    const preferredCondition = EBAY_CONDITION_MAP[item.condition];
    if (!preferredCondition) {
      return res.status(400).json({ error: `Condition "${item.condition}" isn't set, or isn't one eBay recognizes (Like New, Very Good, Good, Fair).` });
    }

    let mappedCondition;
    try {
      mappedCondition = await getValidConditionForCategory(item.ebay_category_id, preferredCondition);
    } catch (err) {
      console.error('Condition policy check failed, using preferred mapping:', err.message);
      mappedCondition = preferredCondition;
    }

    // --- Fetch fresh required aspects and compute effective values (same logic as the card display) ---
    const token = await getEbayApplicationToken();
    const treeId = await getEbayCategoryTreeId();
    const aspectsResponse = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${item.ebay_category_id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const aspectsData = await aspectsResponse.json();
    if (!aspectsResponse.ok) {
      return res.status(502).json({ error: 'Could not verify required fields with eBay', details: aspectsData });
    }

    const aspects = (aspectsData.aspects || []).map(a => ({
      name: a.localizedAspectName,
      required: a.aspectConstraint && a.aspectConstraint.aspectRequired,
      mode: a.aspectConstraint && a.aspectConstraint.aspectMode,
      values: (a.aspectValues || []).map(v => v.localizedValue)
    }));

    const savedAspects = item.ebay_aspects || {};
    const effectiveAspects = {};
    const missingRequired = [];

    for (const a of aspects) {
      const saved = savedAspects[a.name];
      const guess = guessValueForAspectServer(a.name, item);
      const hasControlledValues = a.mode === 'SELECTION_ONLY' && a.values.length > 0;
      const effective = saved || (hasControlledValues ? findClosestValueServer(guess, a.values) : guess);

      if (effective) {
        effectiveAspects[a.name] = [effective];
      } else if (a.required) {
        missingRequired.push(a.name);
      }
    }

    if (missingRequired.length > 0) {
      return res.status(400).json({ error: `Missing required eBay fields: ${missingRequired.join(', ')}` });
    }

    // --- Build the payloads ---
    const sku = item.item_number;
    const imageUrls = images.map(img => `https://stocktracker-app.com/${img.object_key}`);
    const title = [item.department, item.brand, item.colour, item.style, item.category]
      .filter(Boolean).join(' ').slice(0, 80) || `${item.brand || ''} ${item.category || ''}`.trim().slice(0, 80);

    const userToken = await getValidEbayAccessToken();
    const headers = {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-GB',
      'Accept-Language': 'en-GB'
    };

    // Step 1: createOrReplaceInventoryItem
    const inventoryPayload = {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: mappedCondition,
      product: {
        title,
        description: item.generated_description || title,
        imageUrls,
        aspects: effectiveAspects
      }
    };

    const inventoryRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${sku}`, {
      method: 'PUT', headers, body: JSON.stringify(inventoryPayload)
    });

    if (inventoryRes.status !== 200 && inventoryRes.status !== 201 && inventoryRes.status !== 204) {
      const data = await inventoryRes.json().catch(() => ({}));
      console.error('createOrReplaceInventoryItem failed:', JSON.stringify(data));
      return res.status(502).json({ error: 'Failed at step 1 (inventory item)', details: data, step: 'inventory_item' });
    }

    // Step 2: createOffer - but first check if one already exists for this SKU
    // (e.g. from a previous attempt that got this far before failing at publish)
    let offerId;
    const existingOfferRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${sku}&marketplace_id=EBAY_GB`, { headers });
    const existingOfferData = await existingOfferRes.json().catch(() => ({}));

    if (existingOfferRes.ok && existingOfferData.offers && existingOfferData.offers.length > 0) {
      offerId = existingOfferData.offers[0].offerId;
    } else {
      const offerPayload = {
        sku,
        marketplaceId: 'EBAY_GB',
        format: 'FIXED_PRICE',
        availableQuantity: 1,
        categoryId: item.ebay_category_id,
        listingDescription: item.generated_description || title,
        listingPolicies: {
          fulfillmentPolicyId: settings.ebay_fulfillment_policy_id,
          paymentPolicyId: settings.ebay_payment_policy_id,
          returnPolicyId: settings.ebay_return_policy_id
        },
        pricingSummary: {
          price: { value: parseFloat(item.listing_price).toFixed(2), currency: 'GBP' }
        },
        merchantLocationKey: settings.ebay_merchant_location_key
      };

      const offerRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer`, {
        method: 'POST', headers, body: JSON.stringify(offerPayload)
      });
      const offerData = await offerRes.json();

      if (!offerRes.ok) {
        console.error('createOffer failed:', JSON.stringify(offerData));
        return res.status(502).json({ error: 'Failed at step 2 (offer)', details: offerData, step: 'offer' });
      }

      offerId = offerData.offerId;
    }

    // Step 3: publishOffer
    const publishRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}/publish`, {
      method: 'POST', headers
    });
    const publishData = await publishRes.json();

    if (!publishRes.ok) {
      console.error('publishOffer failed:', JSON.stringify(publishData));
      return res.status(502).json({ error: 'Failed at step 3 (publish)', details: publishData, step: 'publish' });
    }

    // Success - save the real listing ID, a clickable link to it, and flip the status
    const ebayListingUrl = `https://www.${EBAY_ENV === 'production' ? '' : 'sandbox.'}ebay.com/itm/${publishData.listingId}`;
    const updateResult = await pool.query(
      `UPDATE items SET ebay_listing_id = $1, ebay_offer_id = $2, ebay_url = $3, active_on_ebay = TRUE, status = 'ACTIVE', updated_at = NOW() WHERE id = $4 RETURNING *`,
      [publishData.listingId, offerId, ebayListingUrl, id]
    );

    res.json({ success: true, listingId: publishData.listingId, item: { ...updateResult.rows[0], generated_description: generateDescription(updateResult.rows[0]) } });
  } catch (err) {
    console.error('Publish to eBay error:', err);
    res.status(500).json({ error: 'Failed to publish to eBay', details: err.message });
  }
});

app.patch('/api/items/:id/category', async (req, res) => {
  try {
    const { id } = req.params;
    const { ebay_category_id, ebay_category_name } = req.body;

    const result = await pool.query(
      `UPDATE items SET ebay_category_id = $1, ebay_category_name = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [ebay_category_id, ebay_category_name, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save category', details: err.message });
  }
});

app.get('/api/ebay/price-check', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'A search query is required' });
    }

    const token = await getEbayApplicationToken();

    const params = new URLSearchParams({
      q: q.trim(),
      limit: '30',
      filter: 'buyingOptions:{FIXED_PRICE}'
    });

    const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('eBay Browse API error:', data);
      return res.status(502).json({ error: 'eBay search failed', details: data });
    }

    const items = data.itemSummaries || [];
    const prices = items
      .map(item => parseFloat(item.price && item.price.value))
      .filter(p => !isNaN(p))
      .sort((a, b) => a - b);

    let median = null;
    if (prices.length > 0) {
      const mid = Math.floor(prices.length / 2);
      median = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    }

    res.json({
      query: q.trim(),
      totalActive: data.total || 0,
      sampledCount: prices.length,
      lowPrice: prices.length > 0 ? prices[0] : null,
      highPrice: prices.length > 0 ? prices[prices.length - 1] : null,
      medianPrice: median,
      sampleItems: items.slice(0, 5).map(item => ({
        title: item.title,
        price: item.price ? item.price.value : null,
        condition: item.condition
      }))
    });
  } catch (err) {
    console.error('Price check error:', err);
    res.status(500).json({ error: 'Failed to check eBay prices', details: err.message });
  }
});

// Manual marketplace-active toggles. Vinted stays manual permanently (no accessible API).
// eBay's toggle is a placeholder until real listing creation exists - once it does,
// this becomes a genuine API-checked status instead of a manual click.
app.patch('/api/items/:id/marketplace-status', async (req, res) => {
  try {
    const { id } = req.params;
    const { active_on_ebay, active_on_vinted } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (active_on_ebay !== undefined) {
      fields.push(`active_on_ebay = $${idx++}`);
      values.push(active_on_ebay);
    }
    if (active_on_vinted !== undefined) {
      fields.push(`active_on_vinted = $${idx++}`);
      values.push(active_on_vinted);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE items SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    res.json({ ...result.rows[0], generated_description: generateDescription(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update marketplace status', details: err.message });
  }
});

// ===================== EBAY INVENTORY LOCATION =====================
// A second one-time prerequisite before any offer can be published - "where this ships from".

app.get('/api/ebay/inventory-location/status', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM app_settings WHERE key = 'ebay_merchant_location_key'");
    res.json({ configured: result.rows.length > 0, merchantLocationKey: result.rows.length > 0 ? result.rows[0].value : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check inventory location status' });
  }
});

app.post('/api/ebay/inventory-location/create', async (req, res) => {
  try {
    const { postalCode } = req.body;
    if (!postalCode || !postalCode.trim()) {
      return res.status(400).json({ error: 'A postal code is required' });
    }

    const token = await getValidEbayAccessToken();
    const merchantLocationKey = 'stocktracker-location-1';

    const response = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/location/${merchantLocationKey}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        location: {
          address: {
            postalCode: postalCode.trim(),
            country: 'GB'
          }
        },
        name: 'StockTracker Warehouse',
        merchantLocationStatus: 'ENABLED',
        locationTypes: ['WAREHOUSE']
      })
    });

    if (response.status !== 204 && !response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error('Inventory location creation failed:', JSON.stringify(data));
      return res.status(502).json({ error: 'Failed to create inventory location', details: data });
    }

    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('ebay_merchant_location_key', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [merchantLocationKey]
    );

    res.json({ success: true, merchantLocationKey });
  } catch (err) {
    console.error('Inventory location error:', err);
    res.status(500).json({ error: 'Failed to create inventory location', details: err.message });
  }
});

// Refresh an existing item's eBay price estimate, saving the result
app.post('/api/items/:id/price-check', async (req, res) => {
  try {
    const { id } = req.params;
    const itemResult = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const item = itemResult.rows[0];

    const cleanedSize = (item.size || '').replace(/\([^)]*\)/g, '').trim();
    const parts = [item.brand, item.department, item.category, cleanedSize];
    let query = parts.filter(p => p && p.trim()).join(' ').trim();

    if (!query) {
      return res.status(400).json({ error: 'Not enough item details to search with' });
    }

    const token = await getEbayApplicationToken();

    const runSearch = async (searchQuery) => {
      const params = new URLSearchParams({
        q: searchQuery,
        limit: '30',
        filter: 'buyingOptions:{FIXED_PRICE}'
      });
      const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB'
        }
      });
      const data = await response.json();
      if (!response.ok) throw new Error('eBay search failed: ' + JSON.stringify(data));
      return data;
    };

    let data = await runSearch(query);

    if (!data.total) {
      const broaderQuery = [item.brand, item.category].filter(p => p && p.trim()).join(' ').trim();
      if (broaderQuery && broaderQuery !== query) {
        const broaderData = await runSearch(broaderQuery);
        if (broaderData.total > 0) {
          data = broaderData;
          query = broaderQuery;
        }
      }
    }

    const items = data.itemSummaries || [];
    const prices = items
      .map(i => parseFloat(i.price && i.price.value))
      .filter(p => !isNaN(p))
      .sort((a, b) => a - b);

    let median = null, low = null, high = null;
    if (prices.length > 0) {
      const mid = Math.floor(prices.length / 2);
      median = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
      low = prices[0];
      high = prices[prices.length - 1];
    }

    const updateResult = await pool.query(
      `UPDATE items SET ebay_estimated_low = $1, ebay_estimated_high = $2, ebay_estimated_median = $3, ebay_estimated_count = $4, ebay_price_checked_at = NOW()
       WHERE id = $5 RETURNING *`,
      [low, high, median, data.total || 0, id]
    );

    res.json({ ...updateResult.rows[0], generated_description: generateDescription(updateResult.rows[0]) });
  } catch (err) {
    console.error('Item price check error:', err);
    res.status(500).json({ error: 'Failed to check eBay prices', details: err.message });
  }
});

// ===================== EBAY BUSINESS POLICIES =====================
// Required one-time setup before any real listing can be published.

app.get('/api/ebay/business-policies/status', async (req, res) => {
  try {
    const token = await getValidEbayAccessToken();
    const response = await fetch(`${EBAY_API_BASE}/sell/account/v1/program/get_opted_in_programs`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to check opt-in status', details: data });
    }
    const programs = (data.programs || []).map(p => p.programType);
    res.json({ optedIn: programs.includes('SELLING_POLICY_MANAGEMENT'), programs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check business policies status', details: err.message });
  }
});

app.post('/api/ebay/business-policies/opt-in', async (req, res) => {
  try {
    const token = await getValidEbayAccessToken();
    const response = await fetch(`${EBAY_API_BASE}/sell/account/v1/program/opt_in`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ programType: 'SELLING_POLICY_MANAGEMENT' })
    });

    if (response.status === 204 || response.ok) {
      return res.json({ success: true });
    }

    const data = await response.json().catch(() => ({}));
    console.error('eBay opt-in failed:', data);
    res.status(502).json({ error: 'eBay opt-in failed - this can be a known Sandbox glitch, try again in a moment', details: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to opt in to business policies', details: err.message });
  }
});

app.post('/api/ebay/business-policies/create', async (req, res) => {
  try {
    const { flatShippingCost } = req.body;
    const shippingCost = parseFloat(flatShippingCost) || 3.99;
    const token = await getValidEbayAccessToken();

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-GB'
    };

    // Fulfillment (shipping) policy - 3 day handling, buyer pays flat rate
    const fulfillmentPayload = {
      name: 'StockTracker Standard Shipping',
      marketplaceId: 'EBAY_GB',
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      handlingTime: { value: 3, unit: 'DAY' },
      shippingOptions: [
        {
          optionType: 'DOMESTIC',
          costType: 'FLAT_RATE',
          shippingServices: [
            {
              sortOrder: 1,
              shippingCarrierCode: 'Royal Mail',
              shippingServiceCode: 'UK_RoyalMailSecondClassStandard',
              shippingCost: { value: shippingCost.toFixed(2), currency: 'GBP' },
              freeShipping: false
            }
          ]
        }
      ]
    };

    const fulfillmentRes = await fetch(`${EBAY_API_BASE}/sell/account/v1/fulfillment_policy`, {
      method: 'POST', headers, body: JSON.stringify(fulfillmentPayload)
    });
    const fulfillmentData = await fulfillmentRes.json();
    if (!fulfillmentRes.ok) {
      console.error('Fulfillment policy failed:', JSON.stringify(fulfillmentData));
      return res.status(502).json({ error: 'Failed to create fulfillment policy', details: fulfillmentData, step: 'fulfillment' });
    }

    // Return policy - 14 days, buyer pays return shipping
    const returnPayload = {
      name: 'StockTracker Standard Returns',
      marketplaceId: 'EBAY_GB',
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      returnsAccepted: true,
      returnPeriod: { value: 14, unit: 'DAY' },
      refundMethod: 'MONEY_BACK',
      returnShippingCostPayer: 'BUYER'
    };

    const returnRes = await fetch(`${EBAY_API_BASE}/sell/account/v1/return_policy`, {
      method: 'POST', headers, body: JSON.stringify(returnPayload)
    });
    const returnData = await returnRes.json();
    if (!returnRes.ok) {
      console.error('Return policy failed:', JSON.stringify(returnData));
      return res.status(502).json({ error: 'Failed to create return policy', details: returnData, step: 'return' });
    }

    // Payment policy - eBay handles payment processing itself on managed-payments marketplaces like the UK
    const paymentPayload = {
      name: 'StockTracker Standard Payment',
      marketplaceId: 'EBAY_GB',
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }]
    };

    const paymentRes = await fetch(`${EBAY_API_BASE}/sell/account/v1/payment_policy`, {
      method: 'POST', headers, body: JSON.stringify(paymentPayload)
    });
    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) {
      console.error('Payment policy failed:', JSON.stringify(paymentData));
      return res.status(502).json({ error: 'Failed to create payment policy', details: paymentData, step: 'payment' });
    }

    const updates = {
      ebay_fulfillment_policy_id: fulfillmentData.fulfillmentPolicyId,
      ebay_return_policy_id: returnData.returnPolicyId,
      ebay_payment_policy_id: paymentData.paymentPolicyId
    };
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, value]
      );
    }

    res.json({ success: true, ...updates });
  } catch (err) {
    console.error('Business policy creation error:', err);
    res.status(500).json({ error: 'Failed to create business policies', details: err.message });
  }
});

app.get('/api/ebay/status', async (req, res) => {
  try {
    const settingsResult = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('ebay_connected_at', 'ebay_refresh_token', 'ebay_token_expires_at')`
    );
    const settings = {};
    settingsResult.rows.forEach(row => { settings[row.key] = row.value; });

    if (!settings.ebay_refresh_token) {
      return res.json({ connected: false });
    }

    // Confirm the connection is actually still good by trying to get a valid token
    try {
      await getValidEbayAccessToken();
      res.json({
        connected: true,
        connectedAt: settings.ebay_connected_at
      });
    } catch (err) {
      res.json({ connected: false, reason: 'Token refresh failed - may need to reconnect' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check eBay status' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
