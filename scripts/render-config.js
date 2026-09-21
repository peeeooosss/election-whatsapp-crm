// Build-time config generator for Vercel static hosting.
// Reads API_BASE from the environment (set in the Vercel project) and writes
// public/config.js. Falls back to hostname detection so the file also works
// served from Render directly.
const fs = require('fs');
const path = require('path');

const apiBase = (process.env.API_BASE || '').trim();
const out = path.join(__dirname, '..', 'public', 'config.js');

let content;
if (apiBase) {
  content = `window.API_BASE = ${JSON.stringify(apiBase)};\n`;
} else {
  content = `window.API_BASE = window.location.hostname.includes('vercel.app') || window.location.hostname.includes('netlify.app')\n  ? 'https://election-whatsapp-crm.onrender.com'\n  : '';\n`;
}

fs.writeFileSync(out, content);
console.log(`[render-config] wrote ${out}`);