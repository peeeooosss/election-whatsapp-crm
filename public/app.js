// Global State
let allData = [];
let filteredData = [];
let progressTimer = null;

// --- Connection Logic ---
async function requestPairingCode() {
  const phone = document.getElementById('phoneInput').value.trim();
  const loader = document.getElementById('connLoader');
  const display = document.getElementById('pairingCodeDisplay');

  if (!phone) return alert('Please enter a phone number');

  loader.style.display = 'block';
  display.style.display = 'none';

  try {
    const res = await fetch('/api/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone }),
    });
    const data = await res.json();

    if (data.success) {
      display.innerText = data.code;
      display.style.display = 'block';
      alert('Code generated! Enter this code in WhatsApp App > Linked Devices > Link Device.');
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Connection failed. Is the server running?');
  } finally {
    loader.style.display = 'none';
  }
}

// Poll connection status so the UI shows linked/unlinked
async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const el = document.getElementById('connStatus');

    if (data.connected) {
      el.className = 'conn-status connected';
      el.innerHTML = '<span class="dot"></span> Connected';
    } else {
      el.className = 'conn-status disconnected';
      el.innerHTML = '<span class="dot"></span> Not connected';
    }
  } catch (err) {
    // server unreachable; ignore, retried on next poll
  }
}

// --- Excel Parsing Logic ---
function handleFileUpload() {
  const file = document.getElementById('excelFile').files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(firstSheet);

    // Normalize keys (trim whitespace)
    allData = jsonData.map((row) => {
      const newRow = {};
      Object.keys(row).forEach((key) => {
        newRow[key.trim()] = row[key];
      });
      return newRow;
    });

    if (allData.length === 0) {
      alert('No rows found in the selected file.');
      return;
    }

    populateFilters();
    renderTable();
    document.getElementById('crmSection').style.display = 'block';
  };

  reader.readAsArrayBuffer(file);
}

function populateFilters() {
  const depts = [...new Set(allData.map((d) => d.Department || d.department))].filter(Boolean).sort();
  const years = [...new Set(allData.map((d) => d.Year || d.year))].filter(Boolean).sort();

  const deptSelect = document.getElementById('filterDept');
  const yearSelect = document.getElementById('filterYear');
  deptSelect.innerHTML = '<option value="">All Departments</option>';
  yearSelect.innerHTML = '<option value="">All Years</option>';

  depts.forEach((d) => deptSelect.add(new Option(d, d)));
  years.forEach((y) => yearSelect.add(new Option(y, y)));
}

// --- Table Rendering & Filtering ---
function renderTable() {
  const search = document.getElementById('searchBox').value.toLowerCase();
  const deptFilter = document.getElementById('filterDept').value;
  const yearFilter = document.getElementById('filterYear').value;

  filteredData = allData.filter((row) => {
    const name = (row.Name || row.name || '').toLowerCase();
    const phone = (row.Phone || row.phone || '').toString();
    const dept = row.Department || row.department || '';
    const year = row.Year || row.year || '';

    const matchesSearch = name.includes(search) || phone.includes(search);
    const matchesDept = deptFilter === '' || dept === deptFilter;
    const matchesYear = yearFilter === '' || year === yearFilter;

    return matchesSearch && matchesDept && matchesYear;
  });

  const tbody = document.querySelector('#crmTable tbody');
  tbody.innerHTML = '';

  filteredData.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.Name || row.name || 'N/A'}</td>
      <td>${row.Phone || row.phone || 'N/A'}</td>
      <td>${row.Department || row.department || '-'}</td>
      <td>${row.Year || row.year || '-'}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('rowCount').innerText = filteredData.length;
}

// --- Smart Tag Injection ---
function insertTag(tag) {
  const textarea = document.getElementById('messageTemplate');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + tag + text.substring(end, text.length);
  textarea.selectionStart = textarea.selectionEnd = start + tag.length;
  textarea.focus();
}

// --- Campaign Progress Polling ---
async function pollProgress() {
  const statusDiv = document.getElementById('campaignStatus');
  try {
    const res = await fetch('/api/progress');
    const data = await res.json();

    if (!data.running) {
      clearInterval(progressTimer);
      progressTimer = null;
      const btn = document.getElementById('startBtn');
      btn.disabled = false;

      if (data.total > 0) {
        statusDiv.innerHTML = `✅ Done! Sent: ${data.sent}, Failed: ${data.failed}, Total: ${data.total}`;
        statusDiv.className = 'status-bar success';
      } else {
        statusDiv.innerHTML = '⏳ No campaign in progress.';
        statusDiv.className = 'status-bar info';
      }
      return;
    }

    const pct = data.total ? Math.round((data.sent / data.total) * 100) : 0;
    statusDiv.innerHTML = `⏳ Sending ${data.sent}/${data.total} (${pct}%). Sent: ${data.sent}, Failed: ${data.failed}. Please do not close this tab.`;
    statusDiv.className = 'status-bar info';
  } catch (err) {
    // ignore transient errors
  }
}

// --- Send Campaign ---
async function startCampaign() {
  if (filteredData.length === 0) return alert('No voters selected to send messages to.');

  const message = document.getElementById('messageTemplate').value;
  if (!message) return alert('Please write a message.');

  if (!confirm(`Send messages to ${filteredData.length} people? This can take a long time due to anti-ban delays.`)) return;

  const statusDiv = document.getElementById('campaignStatus');
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  statusDiv.innerHTML = '⏳ Starting campaign...';
  statusDiv.className = 'status-bar info';

  try {
    const res = await fetch('/api/send-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: filteredData,
        messageTemplate: message,
      }),
    });
    const result = await res.json();

    if (result.success) {
      statusDiv.innerHTML = `🚀 Campaign started for ${result.stats.total} recipients. Polling progress...`;
      statusDiv.className = 'status-bar info';
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = setInterval(pollProgress, 5000);
    } else {
      statusDiv.innerHTML = '❌ Error: ' + result.error;
      statusDiv.className = 'status-bar error';
      btn.disabled = false;
    }
  } catch (err) {
    statusDiv.innerHTML = '❌ Network Error';
    statusDiv.className = 'status-bar error';
    btn.disabled = false;
  }
}

// Refresh connection status on load and every 10s
refreshStatus();
setInterval(refreshStatus, 10000);
