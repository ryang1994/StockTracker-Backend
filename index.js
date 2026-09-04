const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
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

// GET all items
app.get('/api/items', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM items ORDER BY created_at DESC'
    );
    res.json(result.rows);
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
