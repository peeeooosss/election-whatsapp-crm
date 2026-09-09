const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

dotenv.config();

// Lazy-load Baileys (it blocks the event loop on require)
let _baileys = null;
function baileys() {
  if (!_baileys) {
    _baileys = require('@whiskeysockets/baileys');
  }
  return _baileys;
}

dotenv.config();

// --- CONFIG ---
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '91');
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 30000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 55000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const BATCH_PAUSE_MS = Number(process.env.BATCH_PAUSE_MS || 15 * 60 * 1000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const FREE_CREDITS = 20;

const SESSIONS_DIR = (() => {
  if (process.env.SESSIONS_DIR) {
    const resolved = path.resolve(process.env.SESSIONS_DIR);
    try {
      if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    } catch {
      console.warn('[startup] SESSIONS_DIR not writable, falling back to local ./sessions');
    }
  }
  const local = path.join(__dirname, 'sessions');
  if (!fs.existsSync(local)) fs.mkdirSync(local, { recursive: true });
  return local;
})();

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TX_FILE = path.join(DATA_DIR, 'transactions.json');

// --- APP ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(PUBLIC_DIR));

// --- DATA STORE (JSON file DB) ---
function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* ignore corrupt file */ }
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let users = readJSON(USERS_FILE, []);
let transactions = readJSON(TX_FILE, []);

function saveUsers() { writeJSON(USERS_FILE, users); }
function saveTransactions() { writeJSON(TX_FILE, transactions); }

// --- CREDIT TIERS ---
const CREDIT_TIERS = [
  { label: 'Standard', credits: 120, price: 49 }, // ₹0.40/msg — min 100, max 1000
];

// --- WHATSAPP SOCKET ---
let sock = null;
let reconnectTimer = null;

const progress = {
  running: false,
  userId: null,
  total: 0,
  sent: 0,
  failed: 0,
  refunded: 0,
  currentIndex: 0,
  startedAt: null,
};

let whatsAppConnected = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectToWhatsApp() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = baileys();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const newSock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
  });
  sock = newSock;
  newSock.ev.on('creds.update', saveCreds);
  newSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      whatsAppConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[whatsapp] Connection closed (status ${statusCode}). Logged out: ${isLoggedOut}`);
      if (isLoggedOut) { sock = null; return; }
      reconnectTimer = setTimeout(() => { console.log('[whatsapp] Reconnecting...'); connectToWhatsApp(); }, 3000);
    } else if (connection === 'open') {
      whatsAppConnected = true;
      console.log('[whatsapp] Connection opened successfully!');
}
  });
}

// --- PHONE NORMALIZER ---
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  const countryLen = DEFAULT_COUNTRY_CODE.length;
  const hasCountryCode = digits.length > countryLen && digits.startsWith(DEFAULT_COUNTRY_CODE);
  if (!hasCountryCode) digits = DEFAULT_COUNTRY_CODE + digits;
  return digits + '@s.whatsapp.net';
}

// --- AUTH MIDDLEWARE ---
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    const user = users.find((u) => u.id === decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = users.find((u) => u.email === email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hash,
    credits: FREE_CREDITS,
    freeMessagesUsed: 0,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers();

  transactions.push({
    id: Date.now().toString(36),
    userId: user.id,
    type: 'signup_bonus',
    credits: FREE_CREDITS,
    note: 'Free signup bonus',
    createdAt: new Date().toISOString(),
  });
  saveTransactions();

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, credits: user.credits } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = users.find((u) => u.email === email.toLowerCase().trim());
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, credits: user.credits } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = req.user;
  res.json({ id: user.id, name: user.name, email: user.email, credits: user.credits });
});

// --- CREDIT TIERS ---
app.get('/api/tiers', (req, res) => {
  res.json({ tiers: CREDIT_TIERS, upiId: process.env.UPI_ID || '9864854881@ptsbi', upiName: process.env.UPI_NAME || 'Piyush Bhuyan' });
});

// --- PURCHASE REQUEST (manual UPI) ---
app.post('/api/purchase', authMiddleware, (req, res) => {
  const { tierIndex } = req.body || {};
  const tier = CREDIT_TIERS[tierIndex];
  if (!tier) {
    return res.status(400).json({ error: 'Invalid tier' });
  }
  const tx = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: req.user.id,
    userName: req.user.name,
    userEmail: req.user.email,
    type: 'purchase_request',
    credits: tier.credits,
    price: tier.price,
    label: tier.label,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  transactions.push(tx);
  saveTransactions();
  res.json({ success: true, transactionId: tx.id, message: 'Purchase request submitted. Admin will approve after UPI payment confirmation.' });
});

// --- CREDIT HISTORY ---
app.get('/api/credits/history', authMiddleware, (req, res) => {
  const userTx = transactions
    .filter((t) => t.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  res.json({ transactions: userTx });
});

// --- WHATSAPP PAIRING ---
app.post('/api/request-code', authMiddleware, async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  if (!sock) {
    return res.status(500).json({ error: 'WhatsApp engine not initialized' });
  }
  try {
    let cleanNumber = String(phoneNumber).replace(/\D/g, '');
    if (cleanNumber.length === 10) {
      cleanNumber = DEFAULT_COUNTRY_CODE + cleanNumber;
    }
    const code = await sock.requestPairingCode(cleanNumber);
    console.log(`[whatsapp] Pairing code generated for ${cleanNumber}`);
    res.json({ success: true, code });
  } catch (error) {
    console.error('[whatsapp] Error requesting pairing code:', error);
    res.status(500).json({ error: 'Failed to generate pairing code. Check the number.' });
  }
});

// --- SEND BULK (credit-checked) ---
app.post('/api/send-bulk', authMiddleware, async (req, res) => {
  const { targets, messageTemplate } = req.body || {};
  const list = Array.isArray(targets) ? targets : [];

  if (!sock) {
    return res.status(400).json({ error: 'WhatsApp connection missing or not authorized.' });
  }
  if (list.length === 0) {
    return res.status(400).json({ error: 'No targets provided.' });
  }
  if (!whatsAppConnected) {
    return res.status(400).json({ error: 'WhatsApp is not connected yet. Generate a pairing code and link your device first.' });
  }
  if (progress.running) {
    return res.status(409).json({ error: 'A campaign is already running. Please wait.' });
  }

  // Credit check
  const user = req.user;
  if (user.credits < list.length) {
    return res.status(402).json({
      error: `Insufficient credits. You have ${user.credits} credits but need ${list.length}. Buy more credits to continue.`,
      credits: user.credits,
      needed: list.length,
    });
  }

  // Deduct credits upfront
  user.credits -= list.length;
  saveUsers();

  transactions.push({
    id: Date.now().toString(36),
    userId: user.id,
    type: 'credit_deduct',
    credits: -list.length,
    note: `Campaign to ${list.length} recipients`,
    createdAt: new Date().toISOString(),
  });
  saveTransactions();

  console.log(`[campaign] Starting for ${list.length} recipients (user: ${user.email})...`);
  progress.running = true;
  progress.userId = user.id;
  progress.total = list.length;
  progress.sent = 0;
  progress.failed = 0;
  progress.refunded = 0;
  progress.currentIndex = 0;
  progress.startedAt = new Date();

  res.json({
    success: true,
    message: 'Campaign started',
    stats: { total: list.length, creditsRemaining: user.credits },
  });

  for (let i = 0; i < list.length; i++) {
    const target = list[i];
    progress.currentIndex = i;

    if (i > 0 && i % BATCH_SIZE === 0) {
      console.log(`[campaign] Batch limit (${i}) reached. Pausing ${Math.round(BATCH_PAUSE_MS / 60000)} min...`);
      await sleep(BATCH_PAUSE_MS);
    }

    let finalMessage = messageTemplate || '';
    const name = target.Name || target.name || 'Supporter';
    const dept = target.Department || target.department || 'Constituency';
    const year = target.Year || target.year || '2024';
    finalMessage = finalMessage.replace(/{Name}/g, name);
    finalMessage = finalMessage.replace(/{Department}/g, dept);
    finalMessage = finalMessage.replace(/{Year}/g, year);

    const jid = normalizePhone(target.Phone || target.phone);
    if (!jid) {
      progress.failed++;
      continue;
    }

    try {
      await sock.sendMessage(jid, { text: finalMessage });
      console.log(`[campaign] Sent to ${name || jid}`);
      progress.sent++;
    } catch (err) {
      console.error(`[campaign] Failed to send to ${jid}:`, err.message);
      progress.failed++;
      // Auto-refund credit on failure
      user.credits += 1;
      progress.refunded++;
      saveUsers();
    }

    if (i < list.length - 1) {
      const delay = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
      await sleep(delay);
    }
  }

  transactions.push({
    id: Date.now().toString(36),
    userId: user.id,
    type: 'campaign_complete',
    credits: 0,
    note: `Sent: ${progress.sent}, Failed: ${progress.failed}, Refunded: ${progress.refunded}`,
    createdAt: new Date().toISOString(),
  });
  saveTransactions();

  progress.running = false;
  console.log(`[campaign] Finished. Sent ${progress.sent}, failed ${progress.failed}, refunded ${progress.refunded}`);
});

// --- PROGRESS ---
app.get('/api/progress', (req, res) => {
  res.json({
    ...progress,
    remaining: progress.total - progress.sent - progress.failed,
  });
});

// --- STATUS ---
app.get('/api/status', (req, res) => {
  const connected = !!sock && whatsAppConnected;
  res.json({ connected });
});

// --- ADMIN ROUTES ---
app.get('/api/admin/pending', authMiddleware, adminMiddleware, (req, res) => {
  const pending = transactions
    .filter((t) => t.type === 'purchase_request' && t.status === 'pending')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ transactions: pending });
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, (req, res) => {
  const all = transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
  res.json({ transactions: all });
});

app.post('/api/admin/approve', authMiddleware, adminMiddleware, (req, res) => {
  const { transactionId } = req.body || {};
  const tx = transactions.find((t) => t.id === transactionId && t.type === 'purchase_request');
  if (!tx) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  if (tx.status !== 'pending') {
    return res.status(400).json({ error: 'Transaction already processed' });
  }
  tx.status = 'approved';
  tx.approvedAt = new Date().toISOString();
  tx.approvedBy = req.user.email;

  const user = users.find((u) => u.id === tx.userId);
  if (user) {
    user.credits += tx.credits;
    saveUsers();

    transactions.push({
      id: Date.now().toString(36),
      userId: tx.userId,
      type: 'credit_add',
      credits: tx.credits,
      note: `Approved purchase: ${tx.label} (${tx.credits} credits for ₹${tx.price})`,
      createdAt: new Date().toISOString(),
    });
    saveTransactions();
  }

  saveTransactions();
  res.json({ success: true, message: `${tx.credits} credits added to ${tx.userEmail}` });
});

app.post('/api/admin/reject', authMiddleware, adminMiddleware, (req, res) => {
  const { transactionId } = req.body || {};
  const tx = transactions.find((t) => t.id === transactionId && t.type === 'purchase_request');
  if (!tx) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  if (tx.status !== 'pending') {
    return res.status(400).json({ error: 'Transaction already processed' });
  }
  tx.status = 'rejected';
  tx.rejectedAt = new Date().toISOString();
  saveTransactions();
  res.json({ success: true, message: 'Transaction rejected' });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const list = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    credits: u.credits,
    createdAt: u.createdAt,
  }));
  res.json({ users: list });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const totalUsers = users.length;
  const totalCreditsOutstanding = users.reduce((sum, u) => sum + u.credits, 0);
  const totalRevenue = transactions
    .filter((t) => t.type === 'purchase_request' && t.status === 'approved')
    .reduce((sum, t) => sum + (t.price || 0), 0);
  const totalMessagesSent = transactions
    .filter((t) => t.type === 'campaign_complete')
    .reduce((sum, t) => {
      const match = t.note?.match(/Sent: (\d+)/);
      return sum + (match ? parseInt(match[1]) : 0);
    }, 0);
  const pendingPurchases = transactions.filter((t) => t.type === 'purchase_request' && t.status === 'pending').length;

  res.json({ totalUsers, totalCreditsOutstanding, totalRevenue, totalMessagesSent, pendingPurchases });
});

// --- CATCH-ALL: serve app.html for /app and admin.html for /admin ---
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Sessions stored in ${SESSIONS_DIR}`);
  console.log(`Default country code: +${DEFAULT_COUNTRY_CODE}`);
  console.log(`Admin email: ${ADMIN_EMAIL || '(not set)'}`);
  // Start WhatsApp connection after server is listening (lazy-load Baileys)
  setTimeout(() => {
    connectToWhatsApp().catch(e => {
      console.error('[whatsapp] Init error:', e.message);
      console.error(e.stack);
    });
  }, 1000);
});
