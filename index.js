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
      box_number,
      quantity
    } = req.body;

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const createdItems = [];

    for (let i = 0; i < qty; i++) {
      const numResult = await pool.query("SELECT nextval('item_number_seq') AS n");
      const itemNumber = `CL-${String(numResult.rows[0].n).padStart(6, '0')}`;

      const result = await pool.query(
        `INSERT INTO items 
          (item_number, brand, category, size, colour, condition, material, style, department, outer_shell_material, purchase_cost, listing_price, status, box_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [itemNumber, brand, category, size, colour || null, condition, material || null, style || null, department || null, outer_shell_material || null, purchase_cost || null, listing_price || null, status || 'DRAFT', box_number || null]
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
    const { sold_price, selling_fees } = req.body;

    const result = await pool.query(
      `UPDATE items 
       SET status = 'SOLD', sold_price = $1, selling_fees = $2, date_sold = NOW(), updated_at = NOW()
       WHERE id = $3 
       RETURNING *`,
      [sold_price || null, selling_fees || 0, id]
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
