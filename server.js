const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

dotenv.config();

// Lazy-load Baileys (it blocks the event loop on require)
let _baileys = null;
function baileys() {
  if (!_baileys) {
    _baileys = require('@whiskeysockets/baileys');
  }
  return _baileys;
}

// --- CONFIG ---
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '91');
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 20000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 35000);
const WARMUP_SEND_COUNT = Number(process.env.WARMUP_SEND_COUNT || 15);
const WARMUP_MIN_DELAY_MS = Number(process.env.WARMUP_MIN_DELAY_MS || 45000);
const WARMUP_MAX_DELAY_MS = Number(process.env.WARMUP_MAX_DELAY_MS || 60000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const BATCH_PAUSE_MS = Number(process.env.BATCH_PAUSE_MS || 15 * 60 * 1000);
const DAILY_MAX_MSG = Number(process.env.DAILY_MAX_MSG || 600);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const ADMIN_FALLBACKS = ['piyushbhuyan71@gmail.com'];
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '9864854881';
const FREE_CREDITS = Number(process.env.FREE_CREDITS || 50);
const PRICE_PER_MSG = Number(process.env.PRICE_PER_MSG || 0.4);   // ₹0.40 per message
const MIN_QTY = Number(process.env.MIN_QTY || 100);
const MAX_QTY = Number(process.env.MAX_QTY || 1000);

// --- DATABASE (Neon Postgres) ---
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('[db] DATABASE_URL is required. Set it in .env (Neon Postgres connection string).');
  process.exit(1);
}
// Strip pg-unsupported params (channel_binding) from the Neon URL.
const dbUrl = DATABASE_URL
  .replace(/channel_binding=[^&]*&?/, '')
  .replace(/[?&]$/, '');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  max: 4,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      free_messages_used INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      price INTEGER,
      label TEXT,
      note TEXT,
      status TEXT,
      user_name TEXT,
      user_email TEXT,
      approved_at TIMESTAMPTZ,
      approved_by TEXT,
      rejected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      results JSONB NOT NULL DEFAULT '[]'::jsonb,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      refunded INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id, finished_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voter_lists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_voter_lists_user ON voter_lists(user_id, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `);
  console.log('[db] Schema ready (Postgres).');
}

const PUBLIC_DIR = path.join(__dirname, 'public');

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

// --- USER / TX / CAMPAIGN MAPPERS (snake_case columns -> API camelCase) ---
const mapUser = (r) => r && ({
  id: r.id,
  name: r.name,
  email: r.email,
  password: r.password,
  credits: r.credits,
  freeMessagesUsed: r.free_messages_used,
  createdAt: r.created_at,
});

const mapTx = (r) => r && ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  userEmail: r.user_email,
  type: r.type,
  credits: r.credits,
  price: r.price,
  label: r.label,
  note: r.note,
  status: r.status,
  approvedAt: r.approved_at,
  approvedBy: r.approved_by,
  rejectedAt: r.rejected_at,
  createdAt: r.created_at,
});

const mapCampaign = (r) => r && ({
  id: r.id,
  userId: r.user_id,
  message: r.message,
  results: r.results,
  sent: r.sent,
  failed: r.failed,
  refunded: r.refunded,
  total: r.total,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return mapUser(rows[0]);
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return mapUser(rows[0]);
}

async function getUserCredits(id) {
  const { rows } = await pool.query('SELECT credits FROM users WHERE id = $1', [id]);
  return rows[0] ? rows[0].credits : null;
}

async function insertTransaction(tx) {
  await pool.query(
    `INSERT INTO transactions
      (id, user_id, type, credits, price, label, note, status, user_name, user_email, approved_at, approved_by, rejected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tx.id, tx.userId, tx.type, tx.credits, tx.price, tx.label, tx.note, tx.status, tx.userName, tx.userEmail, tx.approvedAt, tx.approvedBy, tx.rejectedAt]
  );
}

// Increase/refund a user's credits atomically.
async function adjustCredits(userId, delta) {
  const { rows } = await pool.query('UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits', [userId, delta]);
  return rows[0] ? rows[0].credits : null;
}

// --- WHATSAPP SOCKET (managed by WhatsAppManager below) ---
const progress = {
  running: false,
  userId: null,
  total: 0,
  sent: 0,
  failed: 0,
  refunded: 0,
  currentIndex: 0,
  startedAt: null,
  nextSendAt: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Postgres-backed Baileys auth state: pairing survives Render redeploys.
async function usePostgresAuthState() {
  const { initAuthCreds, BufferJSON } = baileys();
  const protoModule = require('@whiskeysockets/baileys/WAProto/index.js');
  const proto = protoModule.proto || protoModule.default.proto;

  const readBuf = (parsed) => {
    // pg returns JSONB already parsed; re-run through BufferJSON.reviver to restore Buffers.
    if (parsed === null || parsed === undefined) return null;
    return JSON.parse(JSON.stringify(parsed), BufferJSON.reviver);
  };

  const readData = async (key) => {
    const { rows } = await pool.query('SELECT value FROM whatsapp_state WHERE key = $1', [key]);
    return rows.length ? readBuf(rows[0].value) : null;
  };

  const writeData = async (key, data) => {
    await pool.query(
      'INSERT INTO whatsapp_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(data, BufferJSON.replacer)]
    );
  };

  const removeData = async (key) => {
    await pool.query('DELETE FROM whatsapp_state WHERE key = $1', [key]);
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids || !ids.length) return data;
          const keys = ids.map((id) => `${type}-${id}.json`);
          const { rows } = await pool.query('SELECT key, value FROM whatsapp_state WHERE key = ANY($1)', [keys]);
          const byKey = {};
          for (const row of rows) byKey[row.key] = readBuf(row.value);
          for (const id of ids) {
            let value = byKey[`${type}-${id}.json`] || null;
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}.json`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds.json', creds),
  };
}

// --- DEVICE REGISTRY (which shared WhatsApp number is linked, and by whom) ---
const DEVICE_KEY = 'device';

async function saveDevice(device) {
  await pool.query(
    'INSERT INTO whatsapp_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [DEVICE_KEY, JSON.stringify(device)]
  );
}

async function loadDevice() {
  const { rows } = await pool.query('SELECT value FROM whatsapp_state WHERE key = $1', [DEVICE_KEY]);
  if (!rows.length) return null;
  return rows[0].value;
}

// Clear the WhatsApp session (creds + all pairing keys) but KEEP the device
// record, so the original linker keeps re-pair rights after a logout.
async function clearSessionKeys() {
  await pool.query("DELETE FROM whatsapp_state WHERE key <> 'device'");
}

// --- WHATSAPP SOCKET MANAGER ---
// Replaces the old global `sock`/`whatsAppConnected` with robust lifecycle
// handling: auto-reconnect, pinned device state, and manual reconnect control.
class WhatsAppManager {
  constructor() {
    this.socket = null;
    this.state = 'initializing'; // initializing | connecting | connected | disconnected | logged_out
    this.device = null;          // { number, linkedByUserId, linkedByEmail, linkedAt } persisted in DB
    this.reconnectTimer = null;
    this.initPromise = null;
    this.pendingPair = null;
    this.pairingWindowOpen = false; // true once the socket finishes the noise handshake and enters the pairing window (qr event)
    this.pairingRequestInFlight = false;
  }

  get connected() { return this.state === 'connected' && !!this.socket; }
  get ready() { return !!this.socket; }

  async init() {
    this.device = await loadDevice();
  }

  // Idempotent socket init: returns existing socket or creates a new one.
  async ensureSocket() {
    if (this.socket) return this.socket;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.createSocket();
    try {
      await this.initPromise;
      return this.socket;
    } finally {
      this.initPromise = null;
    }
  }

  async createSocket() {
    const { default: makeWASocket, DisconnectReason, Browsers } = baileys();
    this.DisconnectReason = DisconnectReason;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const { state, saveCreds } = await usePostgresAuthState();
    const newSock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
    });
    this.socket = newSock;
    this.state = 'connecting';
    newSock.ev.on('creds.update', saveCreds);
    newSock.ev.on('connection.update', (update) => this.onConnectionUpdate(update));
    return newSock;
  }

  async onConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;
    if (update.qr) {
      // The noise handshake is complete and WhatsApp is ready for pairing.
      // This is the ONLY reliable signal that requestPairingCode will be
      // accepted by WhatsApp's servers (the code is registered server-side).
      this.pairingWindowOpen = true;
      if (!this.pendingPair) return;
      const pending = this.pendingPair;
      this.pendingPair = null;
      await this.performPairingRequest(pending);
    } else if (connection === 'connecting') {
      this.state = 'connecting';
      // NOTE: Do NOT request a pairing code here. The 'connecting' event fires
      // on process.nextTick before the WebSocket (and the noise handshake) is
      // actually open, so the code would be generated locally but never
      // registered with WhatsApp — the phone would report it as invalid.
    } else if (connection === 'open') {
      this.state = 'connected';
      console.log('[whatsapp] Connection opened successfully!');
      await this.persistDeviceIfNeeded();
    } else if (connection === 'close') {
      this.state = 'disconnected';
      this.pairingWindowOpen = false;
      if (this.pendingPair) {
        const pending = this.pendingPair;
        this.pendingPair = null;
        pending.reject(new Error('WhatsApp connection dropped while generating the pairing code.'));
      }
      const closedSock = this.socket;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === this.DisconnectReason?.loggedOut;
      console.log(`[whatsapp] Connection closed (status ${statusCode}). Logged out: ${isLoggedOut}`);
      if (this.socket === closedSock) this.socket = null;
      if (isLoggedOut) {
        this.state = 'logged_out';
        // Keep the device record (so only the linker can re-pair) but drop the
        // invalid session creds so a fresh pairing is possible.
        await clearSessionKeys();
        return;
      }
      // Guard against a stale timer: only auto-reconnect if no newer socket has
      // been created in the meantime (e.g. a fresh pairing socket).
      this.reconnectTimer = setTimeout(() => {
        if (this.socket !== null) return;  // a newer socket already exists
        console.log('[whatsapp] Reconnecting...');
        this.ensureSocket().catch((e) => console.error('[whatsapp] Reconnect error:', e.message));
      }, 3000);
    }
  }

  async persistDeviceIfNeeded() {
    // On successful connection, capture the real linked number. Keep the pinned
    // linker (set at pairing time) so only they can re-pair later.
    if (this.socket?.user?.id) {
      const number = this.socket.user.id.split('@')[0].split(':')[0];
      const existing = this.device;
      this.device = {
        number,
        linkedByUserId: existing?.linkedByUserId || this.linkedByUserId || null,
        linkedByEmail: existing?.linkedByEmail || this.linkedByEmail || null,
        linkedAt: existing?.linkedAt || new Date().toISOString(),
      };
      await saveDevice(this.device);
    }
  }

  // Generate a fresh pairing code. Uses a brand-new socket so the registration
  // session is clean each time, then calls requestPairingCode only once the
  // socket has genuinely completed the noise handshake (signaled by Baileys'
  // 'qr' / pairing-window update), which is the only moment WhatsApp will
  // actually register the code server-side. Requesting earlier produces a code
  // that the phone reports as invalid. Any dropped connection rejects the wait.
  requestPairingCode(phoneNumber) {
    return this.withFreshSocket((sock) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pendingPair === pair) this.pendingPair = null;
          reject(new Error('Timed out waiting for WhatsApp to be ready for pairing.'));
        }, 45000);
        const pair = {
          phoneNumber,
          resolve: (code) => { clearTimeout(timer); resolve(code); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        };
        this.pendingPair = pair;
        if (this.pairingWindowOpen) {
          // Already inside the pairing window — request immediately.
          this.pendingPair = null;
          this.performPairingRequest(pair);
        }
        // Otherwise onConnectionUpdate(qr) will run performPairingRequest.
      });
    });
  }

  // Actually send the requestPairingCode node on the current socket. Guarded so
  // a qr event (and the immediate-window path above) can never double-fire.
  async performPairingRequest(pair) {
    if (!pair || this.pairingRequestInFlight) return;
    this.pairingRequestInFlight = true;
    try {
      if (!this.socket) throw new Error('No WhatsApp socket available.');
      const code = await this.socket.requestPairingCode(pair.phoneNumber);
      pair.resolve(code);
    } catch (e) {
      pair.reject(e);
    } finally {
      this.pairingRequestInFlight = false;
    }
  }

  // Run `fn` on a clean, brand-new socket (previous socket is ended so no stale
  // registration/session interferes with re-pairing).
  async withFreshSocket(fn) {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { if (this.socket) this.socket.end({ newAlwaysOpen: true }); } catch {}
    this.socket = null;
    this.state = 'connecting';
    this.pairingWindowOpen = false;
    this.pairingRequestInFlight = false;
    await this.ensureSocket();
    if (!this.socket) throw new Error('Could not create a WhatsApp socket.');
    return await fn(this.socket);
  }

  // Force a brand-new socket (used by the Reconnect button and cold starts).
  async reconnect() {
    try { if (this.socket) this.socket.end({ newAlwaysOpen: true }); } catch {}
    this.socket = null;
    this.state = 'connecting';
    this.pairingWindowOpen = false;
    this.pairingRequestInFlight = false;
    await this.ensureSocket();
    return this.state;
  }

  // Permanent disconnect: log out the WhatsApp device and drop the session
  // (creds/keys). The device record is kept so only the linker can re-pair.
  async disconnect() {
    this.state = 'logged_out';
    if (this.pendingPair) {
      const pending = this.pendingPair;
      this.pendingPair = null;
      pending.reject(new Error('Disconnected.'));
    }
    try { if (this.socket) await this.socket.logout(); } catch {}
    this.socket = null;
    await clearSessionKeys();
    return 'disconnected';
  }
}

const wa = new WhatsAppManager();

// Device linking happens via /api/request-code below; those fields pin who gets
// to re-pair if the socket ever disconnects.
async function ensureWhatsApp() {
  await wa.init();
  await wa.ensureSocket();
}

// --- PHONE NORMALIZER ---
// Returns just the digits (no '@s.whatsapp.net'), normalizing common inputs:
//   10-digit local       -> 9876543210        -> 919876543210
//   leading-zero local   -> 09876543210       -> 919876543210
//   0 + intl             -> 0919876543210     -> 919876543210
//   already coded        -> 919876543210      -> 919876543210
//   plain international  -> 9876543210 given CC 91 -> 919876543210
function cleanPhoneNumber(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);    // international escape
  if (digits.startsWith('0')) digits = digits.slice(1);     // drop leading 0
  if (digits.length === 10) {
    digits = DEFAULT_COUNTRY_CODE + digits;                 // always prefix for local
  } else if (!digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    digits = DEFAULT_COUNTRY_CODE + digits;
  }
  digits = digits.slice(0, 13);
  return digits.length >= 11 ? digits : null;
}

function normalizePhone(input) {
  const digits = cleanPhoneNumber(input);
  return digits ? digits + '@s.whatsapp.net' : null;
}

// --- AUTH MIDDLEWARE ---
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    const user = await getUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function isAdminEmail(email) {
  const e = (email || '').toLowerCase().trim();
  return e === ADMIN_EMAIL || ADMIN_FALLBACKS.includes(e);
}

function adminMiddleware(req, res, next) {
  if (!req.user || !isAdminEmail(req.user.email)) {
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
  const cleanEmail = email.toLowerCase().trim();
  const existing = await getUserByEmail(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: name.trim(),
    email: cleanEmail,
    password: hash,
    credits: FREE_CREDITS,
    freeMessagesUsed: 0,
    createdAt: new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO users (id, name, email, password, credits, free_messages_used) VALUES ($1,$2,$3,$4,$5,$6)',
    [user.id, user.name, user.email, user.password, user.credits, user.freeMessagesUsed]
  );
  await insertTransaction({
    id: Date.now().toString(36),
    userId: user.id,
    type: 'signup_bonus',
    credits: FREE_CREDITS,
    note: 'Free signup bonus',
    status: 'completed',
    createdAt: new Date().toISOString(),
  });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, credits: user.credits } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = await getUserByEmail(email.toLowerCase().trim());
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

// --- CREDIT TIERS (dynamic quantity pack: 100-1000 msgs at ₹0.40/msg) ---
app.get('/api/tiers', (req, res) => {
  res.json({
    minQty: MIN_QTY,
    maxQty: MAX_QTY,
    pricePerMsg: PRICE_PER_MSG,
    upiId: process.env.UPI_ID || '9864854881@ptsbi',
    upiName: process.env.UPI_NAME || 'Piyush Bhuyan',
    whatsapp: ADMIN_WHATSAPP,
  });
});

// --- PURCHASE REQUEST (manual UPI; admin credits user after payment) ---
app.post('/api/purchase', authMiddleware, async (req, res) => {
  const quantity = parseInt((req.body || {}).quantity, 10);
  if (!Number.isInteger(quantity)) {
    return res.status(400).json({ error: `Select a quantity between ${MIN_QTY} and ${MAX_QTY} messages.` });
  }
  if (quantity < MIN_QTY || quantity > MAX_QTY) {
    return res.status(400).json({ error: `Quantity must be between ${MIN_QTY} and ${MAX_QTY} messages.` });
  }
  const price = Math.round(quantity * PRICE_PER_MSG);
  const tx = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: req.user.id,
    userName: req.user.name,
    userEmail: req.user.email,
    type: 'purchase_request',
    credits: quantity,
    price,
    label: `${quantity} messages`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await insertTransaction(tx);
  res.json({
    success: true,
    transactionId: tx.id,
    message: 'Purchase request submitted. Pay the admin on UPI and confirm on WhatsApp — then credits will be added.',
    price,
    credits: quantity,
    upiId: process.env.UPI_ID || '9864854881@ptsbi',
    upiName: process.env.UPI_NAME || 'Piyush Bhuyan',
    whatsapp: ADMIN_WHATSAPP,
  });
});

// --- CREDIT HISTORY ---
app.get('/api/credits/history', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ transactions: rows.map(mapTx) });
});

// --- MESSAGE HISTORY (what the user sent) ---
app.get('/api/history', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM campaigns WHERE user_id = $1 ORDER BY finished_at DESC LIMIT 50',
    [req.user.id]
  );
  const userCampaigns = rows.map(mapCampaign).map((c) => ({
    id: c.id,
    message: c.message,
    sent: c.sent,
    failed: c.failed,
    refunded: c.refunded,
    total: c.total,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    results: c.results,
  }));
  res.json({ campaigns: userCampaigns });
});

// --- VOTER LIST PERSISTENCE ---
app.get('/api/voters', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, data, created_at FROM voter_lists WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.user.id]
  );
  if (!rows.length) return res.json({ voters: null });
  res.json({ voters: { id: rows[0].id, name: rows[0].name, data: rows[0].data, createdAt: rows[0].created_at } });
});

app.post('/api/voters', authMiddleware, async (req, res) => {
  try {
    const { name, data } = req.body;
    if (!Array.isArray(data) || !data.length) return res.status(400).json({ error: 'No voter data provided.' });
    const id = crypto.randomUUID();
    const label = name || `Upload ${new Date().toLocaleDateString()}`;
    await pool.query(
      'INSERT INTO voter_lists (id, user_id, name, data) VALUES ($1, $2, $3, $4::jsonb)',
      [id, req.user.id, label, JSON.stringify(data)]
    );
    res.json({ success: true, id, name: label, count: data.length });
  } catch (error) {
    console.error('Error saving voter list:', error);
    res.status(500).json({ error: 'Failed to save voter list.' });
  }
});

// --- WHATSAPP PAIRING ---
// Only one shared number may be linked. The account that generates a pairing
// code becomes its owner ("linker") and is the ONLY one who can re-pair after
// a disconnect (admin can also re-pair).
app.post('/api/request-code', authMiddleware, async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  const isAdmin = isAdminEmail(req.user.email);

  // Already linked to this user? Only the linker (or admin) may re-pair.
  if (wa.device && wa.device.linkedByUserId && wa.device.linkedByUserId !== req.user.id && !isAdmin) {
    return res.status(403).json({
      error: `The shared WhatsApp number is linked to ${wa.device.linkedByEmail || 'another account'}. Only the original linker can generate a pairing code.`,
      linkedByEmail: wa.device.linkedByEmail,
    });
  }

  // If a socket exists and is connected, requestPairingCode is invalid — bail.
  if (wa.connected) {
    return res.status(400).json({
      error: 'WhatsApp is already connected. Use Disconnect to re-pair a new number.',
      connected: true,
    });
  }

  try {
    // Fresh pairing always starts from clean creds (removes any stale session).
    await clearSessionKeys();
    const cleanNumber = cleanPhoneNumber(phoneNumber);
    if (!cleanNumber) {
      throw new Error('Invalid phone number.');
    }

    // Generate the code only after the socket is actually connected to
    // WhatsApp's servers — otherwise the code is silently never registered.
    const code = await wa.requestPairingCode(cleanNumber);
    console.log(`[whatsapp] Pairing code generated for ${cleanNumber} by ${req.user.email}`);
    // Pin this number to the requesting user so only they can re-pair.
    wa.linkedByUserId = req.user.id;
    wa.linkedByEmail = req.user.email;
    wa.device = {
      number: cleanNumber,
      linkedByUserId: req.user.id,
      linkedByEmail: req.user.email,
      linkedAt: new Date().toISOString(),
    };
    await saveDevice(wa.device);
    const expected = cleanPhoneNumber(ADMIN_WHATSAPP);
    res.json({
      success: true,
      code,
      number: cleanNumber,
      warning: (expected && expected !== cleanNumber)
        ? `This code will only link the WhatsApp account for ${cleanNumber}. It will NOT link the config number ${expected}. Make sure ${cleanNumber} is the number shown in the phone's WhatsApp Settings.`
        : undefined,
    });
  } catch (error) {
    const msg = (error && error.message) || '';
    console.error('[whatsapp] Error requesting pairing code:', error);
    res.status(500).json({
      error: /connection|timed out/i.test(msg)
        ? 'Could not reach WhatsApp servers. Try again in a few seconds.'
        : 'Failed to generate pairing code. Check the number and try again.',
    });
  }
});

// --- MANUAL RECONNECT (button) ---
app.post('/api/reconnect', authMiddleware, async (req, res) => {
  try {
    await wa.reconnect();
    res.json({ success: true, state: wa.state });
  } catch (error) {
    console.error('[whatsapp] Reconnect error:', error);
    res.status(500).json({ error: 'Reconnect failed. Try again.' });
  }
});

// --- DISCONNECT / LOGOUT (button) ---
// Logs out the WhatsApp device and clears the linked identity so a new number
// can be paired. Only the linker or an admin may do this.
app.post('/api/disconnect', authMiddleware, async (req, res) => {
  const isAdmin = isAdminEmail(req.user.email);
  if (wa.device && wa.device.linkedByUserId && wa.device.linkedByUserId !== req.user.id && !isAdmin) {
    return res.status(403).json({
      error: 'Only the original linker (or an admin) can disconnect this WhatsApp number.',
    });
  }
  try {
    await wa.disconnect();
    res.json({ success: true, state: 'disconnected' });
  } catch (error) {
    console.error('[whatsapp] Disconnect error:', error);
    res.status(500).json({ error: 'Disconnect failed.' });
  }
});

// --- SEND BULK (credit-checked) ---
app.post('/api/send-bulk', authMiddleware, async (req, res) => {
  const { targets, messageTemplate } = req.body || {};
  const list = Array.isArray(targets) ? targets : [];

  if (!wa.ready) {
    return res.status(400).json({ error: 'WhatsApp connection missing or not authorized.' });
  }
  if (list.length === 0) {
    return res.status(400).json({ error: 'No targets provided.' });
  }
  if (!wa.connected) {
    return res.status(400).json({ error: 'WhatsApp is not connected yet. Generate a pairing code and link your device first.' });
  }
  if (progress.running) {
    return res.status(409).json({ error: 'A campaign is already running. Please wait.' });
  }

  // Credit check against DB
  const user = req.user;
  if (user.credits < list.length) {
    return res.status(402).json({
      error: `Insufficient credits. You have ${user.credits} credits but need ${list.length}. Buy more credits to continue.`,
      credits: user.credits,
      needed: list.length,
    });
  }

  // Daily cap per linked number (safety limit to avoid WhatsApp flagging the SIM).
  const sinceToday = new Date();
  sinceToday.setHours(0, 0, 0, 0);
  const todayCount = await pool.query(
    `SELECT COALESCE(SUM(sent + failed), 0)::int AS n FROM campaigns WHERE user_id = $1 AND started_at >= $2`,
    [user.id, sinceToday.toISOString()]
  );
  const sentToday = todayCount.rows[0]?.n || 0;
  if (sentToday + list.length > DAILY_MAX_MSG) {
    return res.status(429).json({
      error: `Daily limit reached (${DAILY_MAX_MSG} messages per day). Already sent ${sentToday} today.`,
      sentToday,
      limit: DAILY_MAX_MSG,
    });
  }

  // Deduct credits atomically (concurrency-safe)
  const remaining = await adjustCredits(user.id, -list.length);
  if (remaining === null) {
    return res.status(402).json({ error: 'Failed to deduct credits. Try again.' });
  }

  await insertTransaction({
    id: Date.now().toString(36),
    userId: user.id,
    type: 'credit_deduct',
    credits: -list.length,
    note: `Campaign to ${list.length} recipients`,
    status: 'completed',
    createdAt: new Date().toISOString(),
  });

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
    stats: { total: list.length, creditsRemaining: remaining },
  });

  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const results = [];
  const campaignId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Conservative pacing helper: slow warm-up for first few messages, then steady 20-35s.
  const delayFor = (index) => {
    if (index < WARMUP_SEND_COUNT) {
      return Math.floor(Math.random() * (WARMUP_MAX_DELAY_MS - WARMUP_MIN_DELAY_MS + 1)) + WARMUP_MIN_DELAY_MS;
    }
    return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
  };

  for (let i = 0; i < list.length; i++) {
    const target = list[i];
    progress.currentIndex = i;
    progress.nextSendAt = null;

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
    const result = { name, phone: target.Phone || target.phone, jid, status: 'sent' };
    if (!jid) {
      progress.failed++;
      result.status = 'failed';
      result.error = 'Invalid phone number';
      results.push(result);
      continue;
    }

    try {
      // WhatsApp-existence check — avoid fake "sent" for numbers not on WhatsApp
      let onWhatsApp = true;
      try {
        const checks = await wa.socket.onWhatsApp(jid) || [];
        onWhatsApp = checks.some((c) => c && c.exists);
      } catch { /* treat as existing */ }
      if (!onWhatsApp) {
        throw new Error('Number not on WhatsApp');
      }
      await wa.socket.sendMessage(jid, { text: finalMessage });
      console.log(`[campaign] Sent to ${name || jid}`);
      progress.sent++;
    } catch (err) {
      console.error(`[campaign] Failed to send to ${jid}:`, err.message);
      progress.failed++;
      result.status = 'failed';
      result.error = err.message;
      // Auto-refund credit on failure
      await adjustCredits(user.id, 1);
      progress.refunded++;
    }
    results.push(result);

    if (i < list.length - 1) {
      const delay = delayFor(i);
      progress.nextSendAt = Date.now() + delay;
      await sleep(delay);
      progress.nextSendAt = null;
    }
  }

  const realFinishedAt = new Date().toISOString();

  await insertTransaction({
    id: Date.now().toString(36),
    userId: user.id,
    type: 'campaign_complete',
    credits: 0,
    label: campaignId,
    note: `Sent: ${progress.sent}, Failed: ${progress.failed}, Refunded: ${progress.refunded}`,
    status: 'completed',
    createdAt: new Date().toISOString(),
  });

  await pool.query(
    `INSERT INTO campaigns (id, user_id, message, results, sent, failed, refunded, total, started_at, finished_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)`,
    [campaignId, user.id, messageTemplate || '', JSON.stringify(results), progress.sent, progress.failed, progress.refunded, list.length, startedAt, realFinishedAt]
  );

  progress.running = false;
  console.log(`[campaign] Finished. Sent ${progress.sent}, failed ${progress.failed}, refunded ${progress.refunded}`);
});

// --- PROGRESS (includes countdown + ETA) ---
app.get('/api/progress', (req, res) => {
  let nextSendIn = null;
  if (progress.running && progress.nextSendAt) {
    nextSendIn = Math.max(0, progress.nextSendAt - Date.now());
  }
  let etaMs = null;
  if (progress.running) {
    const remaining = Math.max(0, progress.total - progress.sent - progress.failed);
    const avgDelay = (MIN_DELAY_MS + MAX_DELAY_MS) / 2;
    const sendTimeMs = 4000; // roughly per-message send latency
    const batchesRemaining = Math.max(0, Math.ceil(remaining / BATCH_SIZE) - 1);
    etaMs = (nextSendIn || 0) + remaining * (sendTimeMs + avgDelay) + batchesRemaining * BATCH_PAUSE_MS;
  }
  res.json({
    ...progress,
    remaining: progress.total - progress.sent - progress.failed,
    nextSendIn,
    etaMs,
  });
});

// --- STATUS ---
app.get('/api/status', (req, res) => {
  res.json({
    connected: wa.connected,
    state: wa.state,
    deviceNumber: wa.device?.number || null,
    linkedByEmail: wa.device?.linkedByEmail || null,
    linkedAt: wa.device?.linkedAt || null,
    canReconnect: !wa.connected && !!wa.socket,
  });
});

// --- ADMIN ROUTES ---
app.get('/api/admin/pending', authMiddleware, adminMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM transactions WHERE type = 'purchase_request' AND status = 'pending' ORDER BY created_at DESC"
  );
  res.json({ transactions: rows.map(mapTx) });
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200');
  res.json({ transactions: rows.map(mapTx) });
});

app.post('/api/admin/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { transactionId } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM transactions WHERE id = $1 AND type = 'purchase_request' FOR UPDATE",
      [transactionId]
    );
    const tx = rows[0];
    if (!tx) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }
    if (tx.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Transaction already processed' });
    }
    await client.query(
      "UPDATE transactions SET status = 'approved', approved_at = now(), approved_by = $1 WHERE id = $2",
      [req.user.email, transactionId]
    );
    const balance = await adjustCredits(tx.user_id, tx.credits);
    await client.query(
      `INSERT INTO transactions (id, user_id, type, credits, price, label, note, status, user_name, user_email, approved_at, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)`,
      [Date.now().toString(36) + Math.random().toString(36).slice(2, 6), tx.user_id, 'credit_add', tx.credits, tx.price, tx.label, `Approved purchase: ${tx.label} (${tx.credits} credits for ₹${tx.price})`, 'approved', tx.user_name, tx.user_email, req.user.email]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: `${tx.credits} credits added to ${tx.user_email}`, newBalance: balance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin] approve failed:', err.message);
    res.status(500).json({ error: 'Failed to approve transaction' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const { transactionId } = req.body || {};
  const { rowCount } = await pool.query(
    "UPDATE transactions SET status = 'rejected', rejected_at = now() WHERE id = $1 AND type = 'purchase_request' AND status = 'pending'",
    [transactionId]
  );
  if (rowCount === 0) {
    return res.status(404).json({ error: 'Transaction not found or already processed' });
  }
  res.json({ success: true, message: 'Transaction rejected' });
});

// --- ADMIN: manually add credits to a user (e.g. WhatsApp-arranged payment) ---
app.post('/api/admin/add-credits', authMiddleware, adminMiddleware, async (req, res) => {
  const { userId, credits, note } = req.body || {};
  const amount = parseInt(credits, 10);
  const user = await getUserById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Credits must be a positive whole number' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newBalance = await adjustCredits(user.id, amount);
    await client.query(
      `INSERT INTO transactions (id, user_id, type, credits, label, note, status, user_name, user_email, approved_at, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
      [Date.now().toString(36) + Math.random().toString(36).slice(2, 6), user.id, 'credit_add', amount, 'Manual credit', note ? `Manual credit: ${note}` : 'Manual credit from admin', 'approved', user.name, user.email, req.user.email]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: `Added ${amount} credits to ${user.email}. New balance: ${newBalance}`, newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin] add-credits failed:', err.message);
    res.status(500).json({ error: 'Failed to add credits' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, credits, created_at FROM users ORDER BY created_at DESC');
  res.json({
    users: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      credits: r.credits,
      createdAt: r.created_at,
    })),
  });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users)::int AS total_users,
      (SELECT COALESCE(SUM(credits), 0) FROM users)::int AS credits_out,
      (SELECT COALESCE(SUM(price), 0) FROM transactions WHERE type = 'purchase_request' AND status = 'approved')::int AS total_revenue,
      (SELECT COALESCE(SUM(sent), 0) FROM campaigns)::int AS messages_sent,
      (SELECT COUNT(*) FROM transactions WHERE type = 'purchase_request' AND status = 'pending')::int AS pending_purchases
  `);
  const r = rows[0];
  res.json({
    totalUsers: r.total_users,
    totalCreditsOutstanding: r.credits_out,
    totalRevenue: r.total_revenue,
    totalMessagesSent: r.messages_sent,
    pendingPurchases: r.pending_purchases,
  });
});

// --- CATCH-ALL: serve app.html for /app and admin.html for /admin ---
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.listen(PORT, HOST, async () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Default country code: +${DEFAULT_COUNTRY_CODE}`);
  console.log(`Admin email: ${ADMIN_EMAIL || '(set via fallbacks)'}`);
  try {
    await initDb();
  } catch (e) {
    console.error('[db] initDb failed:', e.message);
  }
  // Start WhatsApp connection after server is listening (lazy-load Baileys)
  setTimeout(() => {
    ensureWhatsApp().catch(e => {
      console.error('[whatsapp] Init error:', e.message);
      console.error(e.stack);
    });
  }, 1000);
});