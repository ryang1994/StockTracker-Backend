const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

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

// Configure multer to save files into uploads/{item_id}/
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
    if (file.mimetype.startsWith('image/')) {
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
      const objectKey = `uploads/${itemId}/${file.filename}`;
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
