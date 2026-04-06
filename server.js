require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const mysql   = require('mysql2/promise');

const app = express();
app.use(express.json());
app.use(cors());

// ── DATABASE CONNECTION ───────────────────────────────────────
let db;
async function getDB() {
  if (!db) {
    db = await mysql.createPool({
      host:               process.env.MYSQLHOST,
      user:               process.env.MYSQLUSER,
      password:           process.env.MYSQLPASSWORD,
      database:           process.env.MYSQLDATABASE,
      port:               process.env.MYSQLPORT || 3306,
      waitForConnections: true,
      connectionLimit:    10,
    });
    await initTables();
    console.log('✅ MySQL connected');
  }
  return db;
}

async function initTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payments (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      checkout_id  VARCHAR(100) UNIQUE,
      mpesa_code   VARCHAR(20),
      phone        VARCHAR(20),
      amount       DECIMAL(10,2),
      status       ENUM('pending','confirmed','failed','expired') DEFAULT 'pending',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_checkout (checkout_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS submissions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(150) NOT NULL,
      email       VARCHAR(255) NOT NULL,
      phone       VARCHAR(30)  NOT NULL,
      field       VARCHAR(100) NOT NULL,
      applied_for VARCHAR(255),
      cv_links    TEXT,
      payment_id  INT,
      status      ENUM('pending','reviewed','matched','closed') DEFAULT 'pending',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_email (email),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);
  console.log('✅ Tables ready');
}

const BASE_URL = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

async function getToken() {
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  return res.data.access_token;
}

// ── 1. STK PUSH ───────────────────────────────────────────────
app.post('/mpesa/stkpush', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Phone number required.' });

  const sanitized = phone.replace(/^0/, '254').replace(/^\+/, '').replace(/\s/g, '');
  if (!/^2547\d{8}$/.test(sanitized)) {
    return res.status(400).json({ success: false, error: 'Enter a valid Safaricom number e.g. 0712345678' });
  }

  try {
    const token     = await getToken();
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const password  = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            process.env.MPESA_AMOUNT || 260,
      PartyA:            sanitized,
      PartyB:            process.env.MPESA_SHORTCODE,
      PhoneNumber:       sanitized,
      CallBackURL:       process.env.CALLBACK_URL,
      AccountReference:  'CareerConnect',
      TransactionDesc:   'CV Review Fee'
    };

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const { CheckoutRequestID, ResponseCode, ResponseDescription } = response.data;

    if (ResponseCode === '0') {
      const pool = await getDB();
      await pool.execute(
        'INSERT INTO payments (checkout_id, phone, status) VALUES (?, ?, "pending")',
        [CheckoutRequestID, sanitized]
      );
      return res.json({
        success: true,
        checkoutRequestId: CheckoutRequestID,
        message: 'STK Push sent! Check your phone and enter your M-Pesa PIN.'
      });
    } else {
      return res.json({ success: false, error: ResponseDescription });
    }
  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    return res.status(500).json({ success: false, error: 'Could not initiate payment. Try again.' });
  }
});

// ── 2. MPESA CALLBACK ─────────────────────────────────────────
app.post('/mpesa/callback', async (req, res) => {
  const body = req.body?.Body?.stkCallback;
  if (!body) return res.json({ ResultCode: 0, ResultDesc: 'OK' });
  const { CheckoutRequestID, ResultCode } = body;
  try {
    const pool = await getDB();
    if (ResultCode === 0) {
      const meta  = body.CallbackMetadata?.Item || [];
      const get   = (name) => meta.find(i => i.Name === name)?.Value;
      await pool.execute(
        `UPDATE payments SET status="confirmed", mpesa_code=?, amount=?, phone=?, updated_at=NOW() WHERE checkout_id=?`,
        [get('MpesaReceiptNumber'), get('Amount'), get('PhoneNumber'), CheckoutRequestID]
      );
      console.log(`✅ Payment confirmed: ${get('MpesaReceiptNumber')}`);
    } else {
      await pool.execute(
        'UPDATE payments SET status="failed", updated_at=NOW() WHERE checkout_id=?',
        [CheckoutRequestID]
      );
    }
  } catch (err) { console.error('Callback error:', err.message); }
  res.json({ ResultCode: 0, ResultDesc: 'OK' });
});

// ── 3. POLL STATUS ────────────────────────────────────────────
app.get('/mpesa/status/:checkoutRequestId', async (req, res) => {
  const { checkoutRequestId } = req.params;
  try {
    const pool = await getDB();
    await pool.execute(
      `UPDATE payments SET status="expired" WHERE checkout_id=? AND status="pending" AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
      [checkoutRequestId]
    );
    const [rows] = await pool.execute(
      'SELECT status, mpesa_code, amount, phone FROM payments WHERE checkout_id=?',
      [checkoutRequestId]
    );
    if (rows.length === 0) return res.json({ success: false, status: 'not_found' });
    const p = rows[0];
    return res.json({ success: true, status: p.status, mpesaCode: p.mpesa_code, amount: p.amount, phone: p.phone });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Could not check status.' });
  }
});

// ── 4. SAVE SUBMISSION ────────────────────────────────────────
app.post('/submit', async (req, res) => {
  const { name, email, phone, field, applied_for, cv_links, checkout_id } = req.body;
  if (!name || !email || !phone || !field) {
    return res.status(400).json({ success: false, error: 'All fields are required.' });
  }
  try {
    const pool = await getDB();
    const [pmts] = await pool.execute(
      'SELECT id FROM payments WHERE checkout_id=? AND status="confirmed"',
      [checkout_id]
    );
    if (pmts.length === 0) return res.status(400).json({ success: false, error: 'Payment not verified.' });
    const paymentId = pmts[0].id;
    const [existing] = await pool.execute('SELECT id FROM submissions WHERE payment_id=?', [paymentId]);
    if (existing.length > 0) return res.status(400).json({ success: false, error: 'Already submitted.' });
    await pool.execute(
      `INSERT INTO submissions (name, email, phone, field, applied_for, cv_links, payment_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, email, phone, field, applied_for || 'Direct', cv_links || '', paymentId]
    );
    console.log(`📄 New submission: ${name} — ${field}`);
    return res.json({ success: true, message: 'Profile saved.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Could not save submission.' });
  }
});

// ── 5. ADMIN DASHBOARD ────────────────────────────────────────
app.get('/admin/submissions', async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Unauthorized.' });
  }
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT s.*, p.mpesa_code, p.amount, p.phone AS payer_phone
      FROM submissions s LEFT JOIN payments p ON p.id = s.payment_id
      ORDER BY s.created_at DESC
    `);
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: '🚀 CareerConnect running', env: process.env.MPESA_ENV }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => { await getDB(); console.log(`🚀 Server on port ${PORT}`); });
