(() => {
  'use strict';

  const TOKEN_KEY = 'token';
  const USER_KEY = 'user';
  const API = window.API_BASE || '';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
  function logout() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); localStorage.removeItem('msgTemplate'); window.location.href = '/'; }

  // Client-side JWT expiry check — avoid loading the full page then being redirected
  function isTokenExpired(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp && payload.exp * 1000 < Date.now();
    } catch { return true; }
  }

  const token = getToken();
  if (!token || isTokenExpired(token)) { window.location.href = '/'; return; }

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
  const campaignStatusText = document.getElementById('campaignStatusText');
  const refreshProgressBtn = document.getElementById('refreshProgressBtn');
  const campaignProgressDetail = document.getElementById('campaignProgressDetail');
  const campaignImage = document.getElementById('campaignImage');
  const imageStatus = document.getElementById('imageStatus');
  const imagePreview = document.getElementById('imagePreview');
  const imagePreviewImg = document.getElementById('imagePreviewImg');
  const removeImageBtn = document.getElementById('removeImageBtn');

  // --- State ---
  let allData = [];
  let filteredData = [];
  let progressTimer = null;
  let pricePerMsg = 0.4;
  let minQty = 100;
  let maxQty = 1000;
  let adminWhatsApp = '';
  let selectedImageBase64 = null;
  let selectedImageName = null;

  // --- Image picker (optional campaign image; session-only) ---
  campaignImage.onchange = () => {
    const file = campaignImage.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { alert('Image too large. Max 8 MB.'); campaignImage.value = ''; return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      selectedImageBase64 = e.target.result;
      selectedImageName = file.name;
      imagePreviewImg.src = selectedImageBase64;
      imagePreview.style.display = 'block';
      imageStatus.textContent = `Image: ${file.name} (${(file.size / 1024).toFixed(0)} KB) — will be sent above your message.`;
      imageStatus.style.color = 'var(--success,#27ae60)';
    };
    reader.readAsDataURL(file);
  };

  removeImageBtn.onclick = () => {
    selectedImageBase64 = null;
    selectedImageName = null;
    campaignImage.value = '';
    imagePreview.style.display = 'none';
    imagePreviewImg.src = '';
    imageStatus.textContent = 'No image selected — messages will be text-only.';
    imageStatus.style.color = '';
  };

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
  const userEmail = (getUser() || {}).email || '';

  getPairingBtn.onclick = async () => {
    const phone = phoneInput.value.trim();
    if (!phone) return alert('Enter phone number');
    getPairingBtn.disabled = true;
    getPairingBtn.textContent = 'Generating...';
    pairingCodeDisplay.style.display = 'none';
    try {
      const data = await api('/api/request-code', { method: 'POST', body: JSON.stringify({ phoneNumber: phone }) });
      if (data && data.success && data.code) {
        const num = data.number ? fmtNumber(data.number) : '';
        const warn = data.warning
          ? `<div style="font-size:0.35em;line-height:1.5;color:#e67e22;margin-top:8px;border:1px solid #e67e22;padding:6px 8px;border-radius:6px;">${data.warning}</div>`
          : '';
        pairingCodeDisplay.innerHTML = `<div style="font-size:0.4em;letter-spacing:1px;color:#718096;">Pairing code for ${num || phone}</div>${data.code}${warn}<div id="codeCountdown" style="font-size:0.35em;letter-spacing:1px;color:#e67e22;margin-top:6px;"></div>`;
        pairingCodeDisplay.style.display = 'block';
        alert(`Code generated for ${num || phone}! Enter it in WhatsApp within 2 minutes: WhatsApp Settings > Linked Devices > Link a Device > "Link with phone number instead".`);
        startCodeCountdown(120);
      } else {
        alert(data?.error || 'Failed to generate code');
      }
    } catch { alert('Network error'); }
    getPairingBtn.disabled = false;
    getPairingBtn.textContent = 'Get Pairing Code';
  };

  function startCodeCountdown(seconds) {
    const el = document.getElementById('codeCountdown');
    if (!el) return;
    const tick = () => {
      if (seconds <= 0) {
        el.textContent = 'Code expired — click "Get Pairing Code" to generate a new one.';
        el.style.color = 'var(--danger,#e74c3c)';
        return;
      }
      el.textContent = `${seconds}s remaining to enter the code on your phone`;
      seconds -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  const reconnectBtn = document.getElementById('reconnectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const linkedDeviceInfo = document.getElementById('linkedDeviceInfo');

  reconnectBtn.onclick = async () => {
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = 'Reconnecting...';
    try {
      const data = await api('/api/reconnect', { method: 'POST' });
      if (data && data.success) {
        connStatus.className = 'conn-status disconnected';
        connStatus.innerHTML = '<span class="dot"></span> Reconnecting...';
      } else {
        alert(data?.error || 'Reconnect failed');
      }
    } catch { alert('Network error'); }
    reconnectBtn.disabled = false;
    reconnectBtn.textContent = 'Reconnect';
    checkConnection();
  };

  disconnectBtn.onclick = async () => {
    if (!confirm('Disconnect the linked WhatsApp number? You will need to generate a new pairing code and re-link.')) return;
    disconnectBtn.disabled = true;
    disconnectBtn.textContent = 'Disconnecting...';
    try {
      const data = await api('/api/disconnect', { method: 'POST' });
      if (data && data.success) {
        alert('Disconnected. Generate a new pairing code to link again.');
        phoneInput.value = '';
        pairingCodeDisplay.style.display = 'none';
      } else {
        alert(data?.error || 'Disconnect failed');
      }
    } catch { alert('Network error'); }
    disconnectBtn.disabled = false;
    disconnectBtn.textContent = 'Disconnect';
    checkConnection();
  };

  function fmtNumber(n) {
    if (!n) return '';
    // Drop anything after a device index (e.g. 917086606995:25) before cleaning
    const base = String(n).split(':')[0];
    const d = base.replace(/\D/g, '');
    // Strip leading country code (91) to show user-entered format
    const local = d.startsWith('91') && d.length > 10 ? d.slice(2) : d;
    return local;
  }

  async function checkConnection() {
    try {
      const data = await api('/api/status');
      if (!data) return;
      const num = data.deviceNumber ? fmtNumber(data.deviceNumber) : '';
      const linkedByYou = data.linkedByEmail && data.linkedByEmail.toLowerCase() === userEmail.toLowerCase();
      if (num && !phoneInput.value.trim() && linkedByYou) {
        phoneInput.value = data.deviceNumber;
      }

      if (data.connected) {
        connStatus.className = 'conn-status connected';
        connStatus.innerHTML = `<span class="dot"></span> Connected${num ? ' to ' + num : ''}`;
        reconnectBtn.style.display = 'none';
        disconnectBtn.style.display = linkedByYou ? 'inline-block' : 'none';
        getPairingBtn.disabled = false;
        linkedDeviceInfo.style.display = num ? 'block' : 'none';
        linkedDeviceInfo.innerHTML = num
          ? `Linked device: <strong>${num}</strong> ${linkedByYou ? '<span style="color:var(--success,#27ae60)">(linked by you)</span>' : `(linked by ${data.linkedByEmail})`}` + (linkedByYou ? '' : ' — only the linker/admin can re-pair after a disconnect.')
          : '';
      } else {
        connStatus.className = 'conn-status disconnected';
        connStatus.innerHTML = `<span class="dot"></span> ${data.state === 'connecting' ? 'Connecting...' : data.state === 'logged_out' ? 'Logged out — re-pair required' : 'Not connected'}`;
        reconnectBtn.style.display = data.state === 'disconnected' || data.state === 'connecting' ? 'inline-block' : 'none';
        disconnectBtn.style.display = 'none';
        getPairingBtn.disabled = false;
        linkedDeviceInfo.style.display = num ? 'block' : 'none';
        linkedDeviceInfo.innerHTML = num
          ? `Previously linked: <strong>${num}</strong>${data.linkedByEmail ? ' (linked by ' + data.linkedByEmail + ')' : ''}. ${linkedByYou ? 'You can re-pair a new code.' : 'Only the original linker or admin can re-pair.'}`
          : '';
      }
    } catch {}
  }

  // --- Excel Upload & CRM ---
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
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
      // Persist to server so data survives refresh
      await api('/api/voters', { method: 'POST', body: JSON.stringify({ name: file.name, data: allData }) });
    };
    reader.readAsArrayBuffer(file);
  };

  async function loadSavedVoters() {
    try {
      const data = await api('/api/voters');
      if (data && data.voters && Array.isArray(data.voters.data) && data.voters.data.length) {
        allData = data.voters.data;
        showResults();
      }
    } catch { /* non-fatal */ }
  }

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
    campaignStatusText.textContent = 'Starting campaign...';
    campaignProgressDetail.style.display = 'none';
    refreshProgressBtn.style.display = 'none';

    const res = await api('/api/send-bulk', {
      method: 'POST',
      body: JSON.stringify({
        targets: filteredData,
        messageTemplate: messageTemplate.value,
        base64Image: selectedImageBase64,
        imageName: selectedImageName,
      }),
    });

    if (res && res.success) {
      campaignStatusText.textContent = `Campaign started for ${res.stats.total} recipients. Polling...`;
      refreshProgressBtn.style.display = 'inline-block';
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = setInterval(pollProgress, 5000);
    } else {
      campaignStatus.className = 'status-bar error';
      campaignStatusText.textContent = res?.error || 'Failed to start campaign';
      startBtn.disabled = false;
      refreshProgressBtn.style.display = 'none';
    }
  };

  function fmtSeconds(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `~${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `~${m}m ${rem}s`;
  }

  async function pollProgress() {
    const data = await api('/api/progress');
    if (!data) return;
    if (!data.running) {
      clearInterval(progressTimer);
      progressTimer = null;
      startBtn.disabled = false;
      if (data.aborted) {
        campaignStatus.className = 'status-bar error';
        const reason = data.abortReason || 'Campaign paused';
        campaignStatusText.textContent = `⚠ Paused — ${reason}. Sent: ${data.sent}, Failed: ${data.failed}, Refunded: ${data.refunded}`;
        campaignProgressDetail.style.display = 'block';
        campaignProgressDetail.innerHTML = `<strong>⚠ Campaign ${data.aborted ? 'stopped' : 'paused'}</strong><br>${reason}<br><strong>Sent:</strong> ${data.sent}/${data.total} &nbsp;|&nbsp; <strong>Failed:</strong> ${data.failed} &nbsp;|&nbsp; <strong>Refunded:</strong> ${data.refunded}<br>Unused credits have been refunded to your balance. Re-link WhatsApp on the Settings page, then start a new campaign.`;
      } else {
        campaignStatus.className = 'status-bar success';
        campaignStatusText.textContent = `Done! Sent: ${data.sent}, Failed: ${data.failed}, Refunded: ${data.refunded}`;
        campaignProgressDetail.style.display = 'none';
      }
      refreshProgressBtn.style.display = 'none';
      loadProfile();
      msgHistoryLoaded = false;
      const refreshed = await api('/api/history');
      if (refreshed && refreshed.campaigns) renderMsgHistory(refreshed.campaigns);
      return;
    }
    const pct = data.total ? Math.round((data.sent / data.total) * 100) : 0;
    campaignStatus.className = 'status-bar info';
    campaignStatusText.textContent = `Campaign running — message ${data.currentIndex + 1}/${data.total} (${pct}%)`;

    const lines = [];
    lines.push(`<strong>Sent:</strong> ${data.sent}/${data.total} (${pct}%) &nbsp;|&nbsp; <strong>Failed:</strong> ${data.failed} &nbsp;|&nbsp; <strong>Refunded:</strong> ${data.refunded}`);
    if (selectedImageName || data.imageName) {
      lines.push(`<strong>Image:</strong> ${data.imageName || selectedImageName}`);
    }
    if (data.batchBreak) {
      lines.push(`<strong>⏸ Batch break</strong> (9 min pause after every 100 messages) — resuming in ${data.nextSendIn != null ? fmtSeconds(data.nextSendIn) : '…'}`);
    }
    if (data.nextTarget && data.nextTarget.phone) {
      lines.push(`<strong>Next message sent to:</strong> ${data.nextTarget.name || '—'} (${data.nextTarget.phone})`);
    }
    if (data.nextSendIn != null && !data.batchBreak) {
      lines.push(`<strong>Next message in:</strong> ${fmtSeconds(data.nextSendIn)}`);
    }
    if (data.etaMs != null) {
      lines.push(`<strong>Estimated time left:</strong> ~${Math.max(1, Math.ceil(data.etaMs / 60000))} min`);
    }
    campaignProgressDetail.style.display = 'block';
    campaignProgressDetail.innerHTML = lines.join('<br>');
  }

  refreshProgressBtn.onclick = () => {
    refreshProgressBtn.disabled = true;
    refreshProgressBtn.textContent = 'Refreshing...';
    pollProgress().then(() => {
      refreshProgressBtn.disabled = false;
      refreshProgressBtn.textContent = '↻ Refresh';
    });
  };

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
  loadSavedVoters();

  // Restore message template from localStorage
  const savedMsg = localStorage.getItem('msgTemplate');
  if (savedMsg) messageTemplate.value = savedMsg;
  messageTemplate.addEventListener('input', () => {
    localStorage.setItem('msgTemplate', messageTemplate.value);
  });

  // Auto-reconnect campaign progress if a campaign is running
  (async () => {
    try {
      const prog = await api('/api/progress');
      if (prog && prog.running) {
        campaignStatus.style.display = 'block';
        campaignStatus.className = 'status-bar info';
        campaignStatusText.textContent = 'Reconnecting to campaign...';
        campaignProgressDetail.style.display = 'block';
        refreshProgressBtn.style.display = 'inline-block';
        pollProgress();
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = setInterval(pollProgress, 5000);
      }
    } catch { /* non-fatal */ }
  })();

  // Pre-fetch history data so it's ready when the user opens the panels
  (async () => {
    try {
      const [credits, msgs] = await Promise.all([api('/api/credits/history'), api('/api/history')]);
      if (credits && credits.transactions) {
        historyLoaded = true;
        creditHistoryList.innerHTML = credits.transactions.length === 0
          ? '<p class="text-muted">No transactions yet</p>'
          : credits.transactions.map(t => {
            const sign = t.credits > 0 ? '+' : '';
            const color = t.credits > 0 ? 'var(--success)' : t.credits < 0 ? 'var(--danger)' : '#666';
            const date = new Date(t.createdAt).toLocaleString();
            return `<div class="tx-row"><div class="tx-info"><div class="tx-detail">${t.note || t.type}</div><div class="tx-time">${date}</div></div><div class="tx-amount" style="color:${color}">${sign}${t.credits}</div></div>`;
          }).join('');
      }
      if (msgs && msgs.campaigns) {
        msgHistoryLoaded = true;
        renderMsgHistory(msgs.campaigns);
      }
    } catch { /* non-fatal */ }
  })();
})();
