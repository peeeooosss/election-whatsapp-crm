(() => {
  'use strict';

  const TOKEN_KEY = 'token';
  const USER_KEY = 'user';
  const API = window.API_BASE || '';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
  function logout() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); window.location.href = '/'; }

  if (!getToken()) { window.location.href = '/'; return; }

  async function api(url, opts = {}) {
    const headers = { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json', ...opts.headers };
    const res = await fetch(API + url, { ...opts, headers });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  }

// --- Elements ---
  const creditBadge = document.getElementById('creditBadge');
  const adminLink = document.getElementById('adminLink');
  const phoneInput = document.getElementById('phoneInput');
  const getPairingBtn = document.getElementById('getPairingBtn');
  const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');
  const connStatus = document.getElementById('connStatus');
  const fileInput = document.getElementById('fileInput');
  const crmSection = document.getElementById('crmSection');
  const crmSearch = document.getElementById('crmSearch');
  const crmDeptFilter = document.getElementById('crmDeptFilter');
  const crmYearFilter = document.getElementById('crmYearFilter');
  const rowCount = document.getElementById('rowCount');
  const crmTable = document.getElementById('crmTable');
  const messageTemplate = document.getElementById('messageTemplate');
  const startBtn = document.getElementById('startBtn');
  const campaignStatus = document.getElementById('campaignStatus');
  const historyToggle = document.getElementById('historyToggle');
  const historyContent = document.getElementById('historyContent');
  const creditHistoryList = document.getElementById('creditHistoryList');
  const msgHistoryToggle = document.getElementById('msgHistoryToggle');
  const msgHistoryContent = document.getElementById('msgHistoryContent');
  const msgHistoryList = document.getElementById('msgHistoryList');
  const qtyInput = document.getElementById('qtyInput');
  const buyBtn = document.getElementById('buyBtn');
  const buyPrice = document.getElementById('buyPrice');
  const buyDetails = document.getElementById('buyDetails');
  const buyStatus = document.getElementById('buyStatus');
  const upiIdDisplay = document.getElementById('upiIdDisplay');
  const upiNameDisplay = document.getElementById('upiNameDisplay');
  const whatsappLink = document.getElementById('whatsappLink');

  // --- State ---
  let allData = [];
  let filteredData = [];
  let progressTimer = null;
  let pricePerMsg = 0.4;
  let minQty = 100;
  let maxQty = 1000;
  let adminWhatsApp = '';

  // --- Profile ---
  async function loadProfile() {
    const data = await api('/api/me');
    if (!data) return;
    creditBadge.textContent = `Credits: ${data.credits}`;
    const user = getUser();
    if (user && data.email === (user.email || '').toLowerCase()) {
      // Check if admin (compare against ADMIN_EMAIL from env - show link if user is the one who registered as admin)
      adminLink.style.display = 'inline';
    }
  }

  // --- WhatsApp Connection ---
  getPairingBtn.onclick = async () => {
    const phone = phoneInput.value.trim();
    if (!phone) return alert('Enter phone number');
    getPairingBtn.disabled = true;
    getPairingBtn.textContent = 'Generating...';
    try {
      const data = await api('/api/request-code', { method: 'POST', body: JSON.stringify({ phoneNumber: phone }) });
      if (data && data.success) {
        pairingCodeDisplay.textContent = data.code;
        pairingCodeDisplay.style.display = 'block';
        alert('Code generated! Enter this code in WhatsApp > Linked Devices > Link with phone number.');
      } else {
        alert(data?.error || 'Failed to generate code');
      }
    } catch { alert('Network error'); }
    getPairingBtn.disabled = false;
    getPairingBtn.textContent = 'Get Pairing Code';
  };

  async function checkConnection() {
    try {
      const data = await api('/api/status');
      if (!data) return;
      if (data.connected) {
        connStatus.className = 'conn-status connected';
        connStatus.innerHTML = '<span class="dot"></span> Connected';
      } else {
        connStatus.className = 'conn-status disconnected';
        connStatus.innerHTML = '<span class="dot"></span> Not connected';
      }
    } catch {}
  }

  // --- Excel Upload & CRM ---
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      allData = XLSX.utils.sheet_to_json(ws).map(row => {
        const nr = {};
        Object.keys(row).forEach(k => { nr[k.trim()] = row[k]; });
        return nr;
      });
      if (!allData.length) { alert('No rows found'); return; }
      showResults();
    };
    reader.readAsArrayBuffer(file);
  };

  document.getElementById('loadDemoBtn').onclick = async () => {
    try {
      const res = await fetch(API + '/demo-voters.xlsx');
      const buf = await res.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      allData = XLSX.utils.sheet_to_json(ws);
      if (!allData.length) { alert('No rows found in demo file'); return; }
      rowCount.textContent = '0';
      showResults();
      crmSearch.value = ''; crmDeptFilter.value = ''; crmYearFilter.value = '';
    } catch {
      alert('Could not load demo data. Check the server is online.');
    }
  };

  function showResults() {
    populateFilters();
    window._crmRender = renderTable;
    renderTable();
    crmSection.style.display = 'block';
  }

  function populateFilters() {
    const depts = [...new Set(allData.map(d => d.Department || d.department))].filter(Boolean).sort();
    const years = [...new Set(allData.map(d => d.Year || d.year))].filter(Boolean).sort();
    crmDeptFilter.innerHTML = '<option value="">All Departments</option>' + depts.map(d => `<option value="${d}">${d}</option>`).join('');
    crmYearFilter.innerHTML = '<option value="">All Years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  }

  function renderTable() {
    const search = crmSearch.value.toLowerCase();
    const dept = crmDeptFilter.value;
    const year = crmYearFilter.value;
    filteredData = allData.filter(r => {
      const name = (r.Name || r.name || '').toLowerCase();
      const phone = (r.Phone || r.phone || '').toString();
      const d = r.Department || r.department || '';
      const y = r.Year || r.year || '';
      return (name.includes(search) || phone.includes(search)) && (!dept || d === dept) && (!year || y === year);
    });
    const tbody = crmTable.querySelector('tbody');
    tbody.innerHTML = filteredData.map(r => `<tr>
      <td>${r.Name || r.name || 'N/A'}</td>
      <td>${r.Phone || r.phone || 'N/A'}</td>
      <td>${r.Department || r.department || '-'}</td>
      <td>${r.Year || r.year || '-'}</td>
    </tr>`).join('');
    rowCount.textContent = filteredData.length;
  }

  // --- Tag Insertion ---
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.onclick = () => {
      const tag = btn.dataset.tag;
      const ta = messageTemplate;
      const start = ta.selectionStart;
      ta.value = ta.value.substring(0, start) + tag + ta.value.substring(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = start + tag.length;
      ta.focus();
    };
  });

  // --- Campaign ---
  startBtn.onclick = async () => {
    if (!filteredData.length) return alert('Upload an Excel file first');
    if (!messageTemplate.value.trim()) return alert('Write a message');
    if (!confirm(`Send to ${filteredData.length} people? This will take time due to anti-ban delays.`)) return;

    startBtn.disabled = true;
    campaignStatus.style.display = 'block';
    campaignStatus.className = 'status-bar info';
    campaignStatus.textContent = 'Starting campaign...';

    const res = await api('/api/send-bulk', {
      method: 'POST',
      body: JSON.stringify({ targets: filteredData, messageTemplate: messageTemplate.value }),
    });

    if (res && res.success) {
      campaignStatus.textContent = `Campaign started for ${res.stats.total} recipients. Polling...`;
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = setInterval(pollProgress, 5000);
    } else {
      campaignStatus.className = 'status-bar error';
      campaignStatus.textContent = res?.error || 'Failed to start campaign';
      startBtn.disabled = false;
    }
  };

  async function pollProgress() {
    const data = await api('/api/progress');
    if (!data) return;
    if (!data.running) {
      clearInterval(progressTimer);
      progressTimer = null;
      startBtn.disabled = false;
      campaignStatus.className = 'status-bar success';
      campaignStatus.textContent = `Done! Sent: ${data.sent}, Failed: ${data.failed}, Refunded: ${data.refunded}`;
      loadProfile(); // refresh credit balance
      msgHistoryLoaded = false; // reload history next time it's opened
      const refreshed = await api('/api/history');
      if (refreshed && refreshed.campaigns && refreshed.campaigns.length && msgHistoryContent.style.display === 'block') {
        msgHistoryLoaded = true;
        renderMsgHistory(refreshed.campaigns);
      }
      return;
    }
    const pct = data.total ? Math.round((data.sent / data.total) * 100) : 0;
    let extra = '';
    if (data.nextSendIn != null) {
      const secs = Math.max(0, Math.round(data.nextSendIn / 1000));
      extra += ` | Next msg in: ~${secs}s`;
    }
    if (data.etaMs != null) {
      const mins = Math.max(0, Math.ceil(data.etaMs / 60000));
      extra += ` | Time left: ~${mins}min`;
    }
    campaignStatus.className = 'status-bar info';
    campaignStatus.textContent = `Sending ${data.sent}/${data.total} (${pct}%) | Failed: ${data.failed} | Refunded: ${data.refunded}${extra}`;
  }

  // --- Credit History ---
  let historyLoaded = false;
  historyToggle.onclick = async () => {
    if (historyContent.style.display === 'none') {
      historyContent.style.display = 'block';
      historyToggle.textContent = '▼ Credit History';
      if (!historyLoaded) {
        historyLoaded = true;
        const data = await api('/api/credits/history');
        if (data && data.transactions) {
          creditHistoryList.innerHTML = data.transactions.length === 0
            ? '<p class="text-muted">No transactions yet</p>'
            : data.transactions.map(t => {
              const sign = t.credits > 0 ? '+' : '';
              const color = t.credits > 0 ? 'var(--success)' : t.credits < 0 ? 'var(--danger)' : '#666';
              const date = new Date(t.createdAt).toLocaleString();
              return `<div class="tx-row">
                <div class="tx-info">
                  <div class="tx-detail">${t.note || t.type}</div>
                  <div class="tx-time">${date}</div>
                </div>
                <div class="tx-amount" style="color:${color}">${sign}${t.credits}</div>
              </div>`;
            }).join('');
        }
      }
    } else {
      historyContent.style.display = 'none';
      historyToggle.textContent = '▶ Credit History';
    }
  };

  // --- Buy Credits ---
  async function loadTiers() {
    try {
      const data = await api('/api/tiers');
      if (!data) return;
      pricePerMsg = data.pricePerMsg || 0.4;
      minQty = data.minQty || 100;
      maxQty = data.maxQty || 1000;
      adminWhatsApp = data.whatsapp || '';
      document.getElementById('pricePerMsg').textContent = pricePerMsg.toFixed(2);
      qtyInput.min = minQty; qtyInput.max = maxQty; qtyInput.value = minQty;
      updateBuyPrice();
    } catch { /* non-fatal */ }
  }

  function updateBuyPrice() {
    const qty = clampQty(parseInt(qtyInput.value, 10) || 0);
    buyPrice.textContent = Math.round(qty * pricePerMsg);
  }

  function clampQty(qty) {
    if (isNaN(qty)) return minQty;
    return Math.min(maxQty, Math.max(minQty, qty));
  }

  qtyInput.oninput = () => {
    const clamped = clampQty(parseInt(qtyInput.value, 10));
    buyPrice.textContent = Math.round(clamped * pricePerMsg);
  };

  qtyInput.onchange = () => qtyInput.value = clampQty(parseInt(qtyInput.value, 10));

  let purchaseMade = null;
  buyBtn.onclick = async () => {
    const qty = clampQty(parseInt(qtyInput.value, 10));
    qtyInput.value = qty;
    buyStatus.style.display = 'none';
    buyBtn.disabled = true;
    buyBtn.textContent = 'Placing request...';
    try {
      const data = await api('/api/purchase', { method: 'POST', body: JSON.stringify({ quantity: qty }) });
      if (data && data.success) {
        purchaseMade = data;
        // show payment details
        const price = document.getElementById('buyPrice').textContent;
        document.getElementById('buyPrice2').textContent = price;
        upiIdDisplay.textContent = data.upiId;
        upiNameDisplay.textContent = data.upiName;
        whatsappLink.href = `https://wa.me/${data.whatsapp}?text=${encodeURIComponent(`Hi, I want to buy ${qty} messages for ₹${price}. My email is ${(getUser() || {}).email || ''}. I've paid on UPI — please add credits.`)}`;
        buyDetails.style.display = 'block';
        buyStatus.className = 'status-bar success';
        buyStatus.textContent = data.message;
        buyStatus.style.display = 'block';
      } else {
        buyStatus.className = 'status-bar error';
        buyStatus.textContent = data?.error || 'Failed to place purchase request';
        buyStatus.style.display = 'block';
      }
    } catch {
      buyStatus.className = 'status-bar error';
      buyStatus.textContent = 'Network error';
      buyStatus.style.display = 'block';
    }
    buyBtn.disabled = false;
    buyBtn.textContent = 'Buy Now';
  };

  // --- Sent Message History ---
  function renderMsgHistory(campaigns) {
    msgHistoryList.innerHTML = campaigns.length === 0
      ? '<p class="text-muted">No campaigns sent yet</p>'
      : campaigns.map((c, idx) => `<div class="history-item">
          <div class="history-summary" data-i="${idx}" style="cursor:pointer;">
            <strong>${new Date(c.finishedAt).toLocaleString()}</strong>
            <span>Sent: ${c.sent} | Failed: ${c.failed} | Refunded: ${c.refunded} | Total: ${c.total}</span>
          </div>
          <div class="history-detail" id="histDetail${idx}" style="display:none; margin-top:8px;">
            <div class="history-msg"><strong>Message:</strong><br><span style="white-space:pre-wrap;">${c.message || '(empty)'}</span></div>
            <div class="history-recipients" style="margin-top:8px;">
              ${c.results.map(r => `<div class="recipient-row ${(r.status === 'failed' || r.status === 'refunded') ? 'status-failed' : ''}">
                <span>${r.name || '—'}</span><span>${r.phone || ''}</span>
                <span>${r.status}${r.error ? ` (${r.error})` : ''}</span>
              </div>`).join('')}
            </div>
          </div>
        </div>`).join('');
    msgHistoryList.querySelectorAll('.history-summary').forEach(el => {
      el.onclick = () => {
        const detail = document.getElementById('histDetail' + el.dataset.i);
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      };
    });
  }

  let msgHistoryLoaded = false;
  msgHistoryToggle.onclick = async () => {
    if (msgHistoryContent.style.display === 'none') {
      msgHistoryContent.style.display = 'block';
      msgHistoryToggle.textContent = '▼ Sent Message History';
      if (!msgHistoryLoaded) {
        msgHistoryLoaded = true;
        const data = await api('/api/history');
        if (data && data.campaigns) renderMsgHistory(data.campaigns);
      }
    } else {
      msgHistoryContent.style.display = 'none';
      msgHistoryToggle.textContent = '▶ Sent Message History';
    }
  };

  // --- Logout ---
  document.getElementById('logoutBtn').onclick = logout;

  // --- Init ---
  loadProfile();
  loadTiers();
  checkConnection();
  setInterval(checkConnection, 10000);
})();
