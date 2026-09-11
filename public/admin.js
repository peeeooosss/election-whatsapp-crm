(() => {
  'use strict';

  function getToken() { return localStorage.getItem('token'); }
  const API = window.API_BASE || '';
  function logout() { localStorage.removeItem('token'); localStorage.removeItem('user'); window.location.href = '/'; }

  if (!getToken()) { window.location.href = '/'; return; }

  async function api(url, opts = {}) {
    const headers = { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json', ...opts.headers };
    const res = await fetch(API + url, { ...opts, headers });
    if (res.status === 401 || res.status === 403) { logout(); return null; }
    return res.json();
  }

  const statsGrid = document.getElementById('statsGrid');
  const pendingList = document.getElementById('pendingList');
  const txList = document.getElementById('txList');
  const usersWrap = document.getElementById('usersWrap');
  const lastUpdated = document.getElementById('lastUpdated');
  const creditUserSelect = document.getElementById('creditUserSelect');
  const creditAmount = document.getElementById('creditAmount');
  const addCreditsBtn = document.getElementById('addCreditsBtn');
  const addCreditsStatus = document.getElementById('addCreditsStatus');

  function timestamp() { lastUpdated.textContent = 'Updated: ' + new Date().toLocaleTimeString(); }

  // --- Stats ---
  async function loadStats() {
    const data = await api('/api/admin/stats');
    if (!data) return;
    statsGrid.innerHTML = [
      { icon: '👤', value: data.totalUsers, label: 'Total Users' },
      { icon: '🎟️', value: data.totalCreditsOutstanding.toLocaleString(), label: 'Credits Outstanding' },
      { icon: '💰', value: '₹' + data.totalRevenue.toLocaleString(), label: 'Revenue' },
      { icon: '📨', value: data.totalMessagesSent.toLocaleString(), label: 'Messages Sent' },
      { icon: '⏳', value: data.pendingPurchases, label: 'Pending Purchases' },
    ].map(s => `<div class="stat-card"><div class="stat-value">${s.icon} ${s.value}</div><div class="stat-label">${s.label}</div></div>`).join('');
  }

  // --- Pending Purchases ---
  async function loadPending() {
    const data = await api('/api/admin/pending');
    if (!data) return;
    if (!data.transactions.length) {
      pendingList.innerHTML = '<p class="text-muted text-center" style="padding:20px;">No pending purchases</p>';
      return;
    }
    pendingList.innerHTML = data.transactions.map(t => {
      const date = new Date(t.createdAt).toLocaleString();
      return `<div class="tx-row">
        <div class="tx-info">
          <div class="tx-user">${t.userName} (${t.userEmail})</div>
          <div class="tx-detail">${t.label} — ${t.credits} credits — ₹${t.price}</div>
          <div class="tx-time">${date}</div>
        </div>
        <div class="tx-actions">
          <button class="btn btn-success btn-sm" onclick="adminApprove('${t.id}')">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="adminReject('${t.id}')">Reject</button>
        </div>
      </div>`;
    }).join('');
  }

  window.adminApprove = async (txId) => {
    if (!confirm('Approve this purchase and add credits?')) return;
    await api('/api/admin/approve', { method: 'POST', body: JSON.stringify({ transactionId: txId }) });
    refreshAll();
  };

  window.adminReject = async (txId) => {
    if (!confirm('Reject this purchase?')) return;
    await api('/api/admin/reject', { method: 'POST', body: JSON.stringify({ transactionId: txId }) });
    refreshAll();
  };

  // --- All Transactions ---
  async function loadTransactions() {
    const data = await api('/api/admin/transactions');
    if (!data) return;
    if (!data.transactions.length) {
      txList.innerHTML = '<p class="text-muted text-center" style="padding:20px;">No transactions yet</p>';
      return;
    }
    txList.innerHTML = data.transactions.map(t => {
      const date = new Date(t.createdAt).toLocaleString();
      const badge = t.status === 'approved' ? 'badge-approved' : t.status === 'rejected' ? 'badge-rejected' : t.status === 'pending' ? 'badge-pending' : '';
      const sign = t.credits > 0 ? '+' : '';
      return `<div class="tx-row">
        <div class="tx-info">
          <div class="tx-user">${t.userEmail || t.userId}</div>
          <div class="tx-detail">${t.note || t.type} ${badge ? `<span class="badge ${badge}">${t.status}</span>` : ''}</div>
          <div class="tx-time">${date}</div>
        </div>
        <div class="tx-amount" style="color:${t.credits > 0 ? 'var(--success)' : t.credits < 0 ? 'var(--danger)' : '#666'}">${sign}${t.credits || 0}</div>
      </div>`;
    }).join('');
  }

  // --- All Users ---
  async function loadUsers() {
    const data = await api('/api/admin/users');
    if (!data) return;
    if (!data.users.length) {
      usersWrap.innerHTML = '<p class="text-muted text-center" style="padding:20px;">No users</p>';
      return;
    }
    usersWrap.innerHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Credits</th><th>Joined</th><th>Adjust Credits</th></tr></thead><tbody>${
      data.users.map(u => `<tr>
        <td>${u.name}</td><td>${u.email}</td><td><strong>${u.credits}</strong></td><td>${new Date(u.createdAt).toLocaleDateString()}</td>
        <td style="white-space:nowrap">
          <input type="number" id="adj_${u.id}" min="1" placeholder="Amount" style="width:75px; padding:4px 6px; border:1px solid var(--border,#e2e8f0); border-radius:6px;">
          <button class="btn btn-sm" style="background:var(--success,#16a34a); color:#fff;" onclick="adjustCredits('${u.id}', 1)">+ Add</button>
          <button class="btn btn-sm" style="background:var(--danger,#dc2626); color:#fff;" onclick="adjustCredits('${u.id}', -1)">− Deduct</button>
        </td>
      </tr>`).join('')
    }</tbody></table>`;
    creditUserSelect.innerHTML = data.users.map(u => `<option value="${u.id}">${u.name} (${u.email}) — ${u.credits} credits</option>`).join('');
  }

  window.adjustCredits = async (userId, dir) => {
    const input = document.getElementById('adj_' + userId);
    const amount = parseInt(input.value, 10);
    if (!amount || amount <= 0) { alert('Enter a positive amount first'); return; }
    const action = dir > 0 ? 'Add' : 'Deduct';
    if (!confirm(`${action} ${amount} credits ${dir > 0 ? 'to' : 'from'} this user?`)) return;
    const data = await api('/api/admin/add-credits', { method: 'POST', body: JSON.stringify({ userId, credits: dir > 0 ? amount : -amount }) });
    if (data && data.success) { input.value = ''; refreshAll(); }
    else alert(data?.error || 'Failed to adjust credits');
  };

  // --- Manual Add Credits ---
  addCreditsBtn.onclick = async () => {
    const userId = creditUserSelect.value;
    const credits = parseInt(creditAmount.value, 10);
    addCreditsStatus.style.display = 'none';
    if (!userId) { showAddCredits('Select a user', 'error'); return; }
    if (!credits || credits <= 0) { showAddCredits('Enter a positive credit amount', 'error'); return; }
    if (!confirm(`Add ${credits} credits to this user?`)) return;
    addCreditsBtn.disabled = true;
    try {
      const data = await api('/api/admin/add-credits', { method: 'POST', body: JSON.stringify({ userId, credits }) });
      if (data && data.success) {
        showAddCredits(data.message, 'success');
        creditAmount.value = '';
        refreshAll();
      } else {
        showAddCredits(data?.error || 'Failed to add credits', 'error');
      }
    } catch {
      showAddCredits('Network error', 'error');
    }
    addCreditsBtn.disabled = false;
  };

  function showAddCredits(msg, kind) {
    addCreditsStatus.className = 'status-bar ' + kind;
    addCreditsStatus.textContent = msg;
    addCreditsStatus.style.display = 'block';
  }

  // --- Refresh All ---
  async function refreshAll() {
    await Promise.all([loadStats(), loadPending(), loadTransactions(), loadUsers()]);
    timestamp();
  }

  // --- Logout ---
  document.getElementById('logoutBtn').onclick = logout;

  // --- Init ---
  refreshAll();
  setInterval(refreshAll, 30000);
})();
