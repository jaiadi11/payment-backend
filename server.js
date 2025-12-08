// server.js - DB-aware complete server (overwrite your file with this)
require('dotenv').config();            // load .env into process.env
const express = require('express');    // load express
const db = require('./db');            // our db helper (db.js)
const app = express();                 // create the Express "app"

app.use(express.json());               // middleware to parse JSON bodies

// simple request logger (helpful while developing)
app.use((req, res, next) => {
  console.log('REQ ->', req.method, req.url);
  next();
});

// health-check
app.get('/', (req, res) => {
  console.log('HANDLER -> GET /');
  res.send('Server is running ✔');
});

// CREATE CODE - writes into DB
app.post('/create-code', async (req, res) => {
  try {
    const { code, amount } = req.body;
    if (!code || typeof amount !== 'number') {
      return res.status(400).json({ error: 'code and amount required' });
    }

    const query = `
      INSERT INTO codes (code, amount)
      VALUES ($1, $2)
      RETURNING id, code, amount, status, created_at
    `;
    const result = await db.query(query, [code, amount]);
    console.log('HANDLER -> POST /create-code inserted:', result.rows[0]);
    return res.json({ status: 'code_created', data: result.rows[0] });
  } catch (err) {
    console.error('create-code error:', err.message || err);
    if (err.code === '23505') { // unique_violation
      return res.status(400).json({ error: 'code already exists' });
    }
    return res.status(500).json({ error: 'Error inserting code' });
  }
});

// REDEEM - atomic check+update
app.post('/redeem', async (req, res) => {
  const client = await db.getClient();
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });

    await client.query('BEGIN');

    const sel = await client.query(
      'SELECT * FROM codes WHERE code=$1 FOR UPDATE',
      [code]
    );

    if (sel.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'code not found' });
    }

    const row = sel.rows[0];
    if (row.status !== 'unused') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'code already used' });
    }

    await client.query('UPDATE codes SET status=$1 WHERE code=$2', ['used', code]);
    await client.query('COMMIT');

    console.log('HANDLER -> POST /redeem succeeded for', code);
    return res.json({ status: 'redeemed', amount: row.amount });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{/* ignore rollback error */});
    console.error('redeem error:', err.message || err);
    return res.status(500).json({ error: 'redeem failed' });
  } finally {
    client.release();
  }
});

// catch-all 404 for any other route
app.use((req, res) => {
  console.log('No route matched for:', req.method, req.url);
  res.status(404).json({ error: 'Not Found', path: req.url, method: req.method });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));


