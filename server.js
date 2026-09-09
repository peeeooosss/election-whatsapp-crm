const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Load environment config from .env (if present)
dotenv.config();

// --- CONFIG ---
// On hosting platforms the port and host are injected via env.
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // bind all interfaces (required on Render/Railway/Fly)
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '91');
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 30000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 55000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const BATCH_PAUSE_MS = Number(process.env.BATCH_PAUSE_MS || 15 * 60 * 1000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

// Where WhatsApp auth creds are stored. For a persistent host, point this at a
// mounted volume (env SESSIONS_DIR) so the linked device survives redeploys.
const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.join(__dirname, 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- APP ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_DIR));

// Ensure the sessions directory exists before Baileys tries to use it
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: LOG_LEVEL });

// Global Socket + auth state
let sock = null;
let reconnectTimer = null;

// Campaign progress tracker (shared with the frontend via an endpoint)
const progress = {
  running: false,
  total: 0,
  sent: 0,
  failed: 0,
  currentIndex: 0,
  startedAt: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- WHATSAPP CONNECTION ---
async function connectToWhatsApp() {
  // Clear any pending reconnect so we don't end up with duplicate sockets
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const newSock = makeWASocket({
    logger,
    printQRInTerminal: false, // We use pairing code, not QR
    auth: state,
    browser: Browsers.ubuntu('Chrome'), // desktop browser (needed for non-QR pairing)
  });

  sock = newSock;

  newSock.ev.on('creds.update', saveCreds);

  newSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[whatsapp] Connection closed (status ${statusCode}). Logged out: ${isLoggedOut}`);

      if (isLoggedOut) {
        sock = null;
        return; // do NOT reconnect on logout
      }

      // Reconnect after a short delay to avoid a tight crash loop
      reconnectTimer = setTimeout(() => {
        console.log('[whatsapp] Reconnecting...');
        connectToWhatsApp();
      }, 3000);
    } else if (connection === 'open') {
      console.log('[whatsapp] ✅ Connection opened successfully!');
    }
  });
}

// Start the socket at boot (waits for a pairing-code request)
connectToWhatsApp();

// --- HELPERS ---
function normalizePhone(input) {
  // Strip everything except digits
  let digits = String(input || '').replace(/\D/g, '');

  if (!digits) return null;

  // If a leading country code is already present (e.g. 11 digits with "91"),
  // keep it. Otherwise prepend the configured default country code.
  const countryLen = DEFAULT_COUNTRY_CODE.length;
  const hasCountryCode = digits.length > countryLen && digits.startsWith(DEFAULT_COUNTRY_CODE);

  if (!hasCountryCode) {
    digits = DEFAULT_COUNTRY_CODE + digits;
  }

  return digits + '@s.whatsapp.net';
}

// --- API ENDPOINTS ---

// 1. Request Pairing Code
app.post('/api/request-code', async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  if (!sock) {
    return res.status(500).json({ error: 'WhatsApp engine not initialized' });
  }

  try {
    const cleanNumber = String(phoneNumber).replace(/\D/g, '');
    const code = await sock.requestPairingCode(cleanNumber);
    console.log(`[whatsapp] Pairing code generated for ${cleanNumber}`);
    res.json({ success: true, code });
  } catch (error) {
    console.error('[whatsapp] Error requesting pairing code:', error);
    res.status(500).json({ error: 'Failed to generate pairing code. Check the number.' });
  }
});

// 2. Send Bulk Messages
app.post('/api/send-bulk', async (req, res) => {
  const { targets, messageTemplate } = req.body || {};

  const list = Array.isArray(targets) ? targets : [];
  if (!sock) {
    return res.status(400).json({ error: 'WhatsApp connection missing or not authorized.' });
  }
  if (list.length === 0) {
    return res.status(400).json({ error: 'No targets provided.' });
  }
  if (progress.running) {
    return res.status(409).json({ error: 'A campaign is already running. Please wait.' });
  }

  // Read fresh connection status before allowing a send
  if (sock.type !== 'open') {
    return res.status(400).json({ error: 'WhatsApp is not connected yet. Generate a pairing code and link your device first.' });
  }

  console.log(`[campaign] Starting for ${list.length} recipients...`);
  progress.running = true;
  progress.total = list.length;
  progress.sent = 0;
  progress.failed = 0;
  progress.currentIndex = 0;
  progress.startedAt = new Date();

  // Respond immediately so the frontend isn't blocked for hours;
  // the campaign runs async and progress can be polled.
  res.json({
    success: true,
    message: 'Campaign started',
    stats: { total: list.length },
  });

  for (let i = 0; i < list.length; i++) {
    const target = list[i];
    progress.currentIndex = i;

    // Batch break
    if (i > 0 && i % BATCH_SIZE === 0) {
      console.log(`[campaign] Batch limit (${i}) reached. Pausing ${Math.round(BATCH_PAUSE_MS / 60000)} min...`);
      await sleep(BATCH_PAUSE_MS);
    }

    // Template replacement with safe fallbacks
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
      console.log(`[campaign] ✅ Sent to ${name || jid}`);
      progress.sent++;
    } catch (err) {
      console.error(`[campaign] ❌ Failed to send to ${jid}:`, err.message);
      progress.failed++;
    }

    // Anti-ban pacing (skip on the very last message to avoid a pointless wait)
    if (i < list.length - 1) {
      const delay = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
      await sleep(delay);
    }
  }

  progress.running = false;
  console.log(`[campaign] Finished. Sent ${progress.sent}, failed ${progress.failed}`);
});

// 3. Campaign Progress (polled by the frontend)
app.get('/api/progress', (req, res) => {
  res.json({
    ...progress,
    running: progress.running,
    remaining: progress.total - progress.sent - progress.failed,
  });
});

// 4. Connection status (so the UI can show linked/unlinked state)
app.get('/api/status', (req, res) => {
  const connected = !!sock && sock.type === 'open';
  res.json({ connected });
});

app.listen(PORT, HOST, () => {
  console.log(`🌐 Server running at http://${HOST}:${PORT}`);
  console.log(`📂 Sessions stored in ${SESSIONS_DIR}`);
  console.log(`📱 Default country code: +${DEFAULT_COUNTRY_CODE}`);
});
