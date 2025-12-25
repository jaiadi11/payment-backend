// server.js - DB-aware complete server (overwrite your file with this)
require('dotenv').config();            // load .env into process.env
const cors = require('cors');
const express = require('express');    // load express
const db = require('./db');            // our db helper (db.js)
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();                 // create the Express "app"
app.use(cors());

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

function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing auth token' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || 'dev_secret_change_me'
    );

    // attach user info to request
    req.user = payload; // { userId, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}


async function creditWalletWithTransaction(
  client,
  walletName,
  amount,
  code
) {
  // 1. Lock wallet row
  const walletRes = await client.query(
    'SELECT * FROM wallets WHERE name=$1 FOR UPDATE',
    [walletName]
  );

  if (walletRes.rowCount === 0) {
    throw new Error('wallet not found');
  }

  const wallet = walletRes.rows[0];

  // 2. Credit wallet
  await client.query(
    'UPDATE wallets SET balance = balance + $1 WHERE name=$2',
    [amount, walletName]
  );

  // 3. Log transaction
  await client.query(
    `INSERT INTO transactions (wallet_id, amount, type, code)
     VALUES ($1, $2, 'credit', $3)`,
    [wallet.id, amount,code]
  );
}


async function debitWalletWithTransaction(
  client,
  walletName,
  amount,
  code
) {
  // 1. Lock wallet row
  const walletRes = await client.query(
    'SELECT * FROM wallets WHERE name=$1 FOR UPDATE',
    [walletName]
  );

  if (walletRes.rowCount === 0) {
    throw new Error('wallet not found');
  }

  const wallet = walletRes.rows[0];

  if (wallet.balance < amount) {
    throw new Error('insufficient balance');
  }

  // 2. Debit wallet
  await client.query(
    'UPDATE wallets SET balance = balance - $1 WHERE name=$2',
    [amount, walletName]
  );

  // 3. Log transaction
  await client.query(
    `INSERT INTO transactions (wallet_id, amount, type, code)
     VALUES ($1, $2, 'debit', $3)`,
    [wallet.id, amount, code]
  );
}

function generatePaymentCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generatePaymentCode(userId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let randomPart = '';

  for (let i = 0; i < 3; i++) {
    randomPart += chars[Math.floor(Math.random() * chars.length)];
  }

  const userPart = String(userId).slice(-2).padStart(2, '0');

  return `U${userPart}${randomPart}`;
}






// CREATE CODE - writes into DB
app.post('/create-code', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user.userId;

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'valid amount required' });
    }

    const code = generatePaymentCode(userId);

    const query = `
      INSERT INTO codes (code, amount, user_id, status)
      VALUES ($1, $2, $3, 'unused')
      RETURNING code, amount, status, created_at
    `;

    const result = await db.query(query, [code, amount, userId]);

    return res.json({
      status: 'code_created',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('create-code error:', err.message);

    if (err.code === '23505') {
      // rare collision → retry logic could be added later
      return res.status(500).json({ error: 'code collision, retry' });
    }

    return res.status(500).json({ error: 'create code failed' });
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

    // debit intermediate wallet + log transaction
await debitWalletWithTransaction(
  client,
  'intermediate',
  row.amount,
  code
);
await creditWalletWithTransaction(
  client,
  'platform',
  row.amount,
  code
);




// mark code as used
await client.query(
  'UPDATE codes SET status=$1 WHERE code=$2',
  ['used', code]
);

await client.query('COMMIT');

return res.json({
  status: 'redeemed',
  amount: row.amount
});

  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{/* ignore rollback error */});
    console.error('redeem error:', err.message || err);
    return res.status(500).json({ error: 'redeem failed' });
  } finally {
    client.release();
  }
});
app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email and password (min 6 chars) required' });
    }

    // Hash the password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert into DB
    const sql = `
      INSERT INTO users (email, password_hash)
      VALUES ($1, $2)
      RETURNING id, email, created_at
    `;
    const result = await db.query(sql, [email, passwordHash]);

    return res.status(201).json({
      status: 'registered',
      user: result.rows[0]
    });

  } catch (err) {
    console.error('register error:', err.message);

    if (err.code === '23505') {
      // Unique constraint error (email already exists)
      return res.status(400).json({ error: 'Email already in use' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }

    // Find user
    const sql = 'SELECT * FROM users WHERE email=$1';
    const result = await db.query(sql, [email]);

    if (result.rowCount === 0) {
      // don't reveal whether email exists
      return res.status(400).json({ error: 'invalid credentials' });
    }

    const user = result.rows[0];

    // Compare password with stored hash
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: 'invalid credentials' });
    }

    // Sign JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'dev_secret_change_me',
      { expiresIn: '1h' }
    );

    return res.json({ status: 'logged_in', token });

  } catch (err) {
    console.error('login error:', err.message || err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

//pin setup
app.post('/set-payment-pin', async (req, res) => {
  try {
    const { email, pin } = req.body;

    if (!email || !pin || pin.length !== 4) {
      return res.status(400).json({ error: 'email and 4-digit pin required' });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const result = await db.query(
      'UPDATE users SET payment_pin_hash=$1 WHERE email=$2 RETURNING id',
      [pinHash, email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user not found' });
    }

    return res.json({ status: 'payment pin set' });

  } catch (err) {
    console.error('set-pin error:', err.message);
    return res.status(500).json({ error: 'internal server error' });
  }
});


// LOGIN - issue JWT
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }

    // fetch user by email
    const sql = 'SELECT * FROM users WHERE email=$1';
    const result = await db.query(sql, [email]);

    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'invalid credentials' });
    }

    const user = result.rows[0];

    // compare password with stored bcrypt hash
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: 'invalid credentials' });
    }

    // sign a JWT (1 hour)
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'dev_secret_change_me',
      { expiresIn: '1h' }
    );

    return res.json({ status: 'logged_in', token });

  } catch (err) {
    console.error('login error:', err.message || err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

// AUTH middleware — verifies JWT and attaches user payload to req.user
function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing or invalid Authorization header' });
  }

  const token = header.slice(7); // remove "Bearer "
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
    req.user = payload; // { userId, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

// Protected example route — use this to test your token
app.get('/protected-example', auth, (req, res) => {
  // req.user is available here
  return res.json({ ok: true, message: `Hello ${req.user.email}`, user: req.user });
});




// catch-all 404 for any other route
app.use((req, res) => {
  console.log('No route matched for:', req.method, req.url);
  res.status(404).json({ error: 'Not Found', path: req.url, method: req.method });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));


