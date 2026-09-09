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
  const tierGrid = document.getElementById('tierGrid');
  const upiBox = document.getElementById('upiBox');
  const upiIdDisplay = document.getElementById('upiIdDisplay');
  const buyAction = document.getElementById('buyAction');
  const submitPaymentBtn = document.getElementById('submitPaymentBtn');
  const buyStatus = document.getElementById('buyStatus');
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

  // --- State ---
  let allData = [];
  let filteredData = [];
  let tiers = [];
  let selectedTier = null;
  let progressTimer = null;

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

  // --- Tiers ---
  async function loadTiers() {
    const data = await api('/api/tiers');
    if (!data) return;
    tiers = data.tiers || [];
    upiIdDisplay.textContent = data.upiId || 'yourname@upi';
    renderTiers();
  }

  function renderTiers() {
    tierGrid.innerHTML = tiers.map((t, i) => {
      const perMsg = (t.price / t.credits).toFixed(2);
      const popular = i === 2 ? ' popular' : '';
      return `<div class="tier-card${popular}" data-index="${i}">
        <div class="tier-label">${t.label}</div>
        <div class="tier-msgs">${t.credits.toLocaleString()}<br><small>messages</small></div>
        <div class="tier-price">₹${t.price.toLocaleString()}</div>
        <div class="tier-per">₹${perMsg}/msg</div>
      </div>`;
    }).join('');

    tierGrid.querySelectorAll('.tier-card').forEach(card => {
      card.onclick = () => {
        tierGrid.querySelectorAll('.tier-card').forEach(c => c.style.borderColor = '#e0e0e0');
        card.style.borderColor = 'var(--primary)';
        selectedTier = parseInt(card.dataset.index);
        upiBox.style.display = 'block';
        buyAction.style.display = 'block';
      };
    });
  }

  submitPaymentBtn.onclick = async () => {
    if (selectedTier === null) return alert('Select a pack first');
    submitPaymentBtn.disabled = true;
    buyStatus.style.display = 'inline-block';
    buyStatus.textContent = 'Submitting...';
    const data = await api('/api/purchase', { method: 'POST', body: JSON.stringify({ tierIndex: selectedTier }) });
    if (data && data.success) {
      buyStatus.textContent = `Request submitted! (ID: ${data.transactionId}). Admin will approve after UPI verification.`;
      buyStatus.className = 'status-bar success';
      buyStatus.style.display = 'inline-block';
    } else {
      buyStatus.textContent = data?.error || 'Failed';
      buyStatus.className = 'status-bar error';
      buyStatus.style.display = 'inline-block';
    }
    submitPaymentBtn.disabled = false;
  };

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
      populateFilters();
      window._crmRender = renderTable;
      renderTable();
      crmSection.style.display = 'block';
    };
    reader.readAsArrayBuffer(file);
  };

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
      return;
    }
    const pct = data.total ? Math.round((data.sent / data.total) * 100) : 0;
    campaignStatus.className = 'status-bar info';
    campaignStatus.textContent = `Sending ${data.sent}/${data.total} (${pct}%) | Failed: ${data.failed} | Refunded: ${data.refunded}`;
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

  // --- Logout ---
  document.getElementById('logoutBtn').onclick = logout;

  // --- Init ---
  loadProfile();
  loadTiers();
  checkConnection();
  setInterval(checkConnection, 10000);
})();
