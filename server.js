'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const PORT           = parseInt(process.env.PORT ?? '3000', 10);
const API_SECRET     = process.env.API_SECRET ?? '';
const SUPABASE_URL   = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY   = process.env.SUPABASE_ANON_KEY ?? '';
const LOG_FILE       = process.env.LOG_TO_FILE === 'true'
    ? path.join(__dirname, 'sms_log.jsonl') : null;

if (!API_SECRET)   { console.error('❌ API_SECRET not set');   process.exit(1); }
if (!SUPABASE_URL) { console.error('❌ SUPABASE_URL not set'); process.exit(1); }
if (!SUPABASE_KEY) { console.error('❌ SUPABASE_ANON_KEY not set'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── In-memory store for API-received messages ─────────────────────────────
const smsStore = [];
let nextId = 1;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hashPassword(password) {
  const crypto = require('crypto');
  const salt   = 'sms_fwd_salt_7x9k2p_2025';
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function decryptBody(encrypted) {
  try {
    const key          = 'sms_fwd_enc_key_x9k2025';
    const keyBytes     = Buffer.from(key);
    const encBytes     = Buffer.from(encrypted, 'base64');
    const decrypted    = Buffer.alloc(encBytes.length);
    for (let i = 0; i < encBytes.length; i++) {
      decrypted[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    return decrypted.toString('utf8');
  } catch { return encrypted; }
}

// ── API auth middleware ───────────────────────────────────────────────────
function requireApiSecret(req, res, next) {
  if ((req.headers['x-api-secret'] ?? '') !== API_SECRET) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
}

// ══════════════════════════════════════════════════════════════════════════
// SHARED HTML SHELL
// ══════════════════════════════════════════════════════════════════════════
function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#f0f2f8;color:#1a1a2e;min-height:100vh}
    /* NAV */
    nav{background:linear-gradient(135deg,#1a237e,#283593);
        color:#fff;padding:16px 28px;display:flex;align-items:center;
        justify-content:space-between;box-shadow:0 2px 12px rgba(0,0,0,.25)}
    nav .brand{font-size:18px;font-weight:800;letter-spacing:-.3px}
    nav .brand span{opacity:.7;font-weight:400;font-size:13px;margin-left:8px}
    nav a{color:#fff;text-decoration:none;font-size:13px;
          background:rgba(255,255,255,.15);padding:6px 14px;
          border-radius:20px;transition:background .2s}
    nav a:hover{background:rgba(255,255,255,.28)}
    /* CONTENT */
    .page{max-width:1100px;margin:0 auto;padding:32px 20px}
    /* CARDS */
    .card{background:#fff;border-radius:16px;
          box-shadow:0 2px 10px rgba(0,0,0,.07);overflow:hidden}
    /* STATS ROW */
    .stats{display:flex;gap:14px;margin-bottom:24px;flex-wrap:wrap}
    .stat{background:#fff;border-radius:14px;padding:20px 24px;flex:1;
          min-width:130px;box-shadow:0 2px 10px rgba(0,0,0,.07)}
    .stat .n{font-size:34px;font-weight:900;color:#3f51b5}
    .stat .l{font-size:12px;color:#9e9e9e;margin-top:2px}
    /* TABLE */
    .card-head{padding:18px 22px;display:flex;align-items:center;
               justify-content:space-between;border-bottom:1px solid #f0f0f0}
    .card-head h2{font-size:15px;font-weight:700}
    .hint{font-size:11px;color:#bbb}
    table{width:100%;border-collapse:collapse}
    th{background:#fafafa;padding:11px 16px;text-align:left;font-size:11px;
       font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#aaa;
       border-bottom:1px solid #f0f0f0}
    td{padding:13px 16px;font-size:13px;border-bottom:1px solid #f7f7f7;
       vertical-align:top}
    tr:last-child td{border:none}
    tr:hover td{background:#f9f9ff}
    .pill{display:inline-block;padding:3px 10px;border-radius:20px;
          font-size:11px;font-weight:700}
    .pill-blue{background:#e8eaf6;color:#3f51b5}
    .pill-green{background:#e8f5e9;color:#2e7d32}
    .pill-red{background:#ffebee;color:#c62828}
    .msg{max-width:300px;word-break:break-word;line-height:1.5}
    .grey{color:#aaa;font-size:12px}
    /* EMPTY */
    .empty{text-align:center;padding:56px 20px;color:#ccc}
    .empty .ico{font-size:44px;margin-bottom:12px}
    .empty p{font-size:14px}
    /* LOGIN */
    .login-wrap{min-height:100vh;display:flex;align-items:center;
                justify-content:center;
                background:linear-gradient(135deg,#1a237e,#3949ab)}
    .login-box{background:#fff;border-radius:20px;padding:44px 38px;
               width:100%;max-width:400px;
               box-shadow:0 20px 60px rgba(0,0,0,.3)}
    .login-box .ico{font-size:44px;text-align:center;margin-bottom:6px}
    .login-box h1{text-align:center;font-size:22px;font-weight:800;
                  color:#1a237e;margin-bottom:4px}
    .login-box .sub{text-align:center;color:#aaa;font-size:13px;
                    margin-bottom:30px}
    label{display:block;font-size:11px;font-weight:700;color:#777;
          text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
    input[type=text],input[type=password]{
      width:100%;padding:13px 15px;border:2px solid #e8e8e8;
      border-radius:12px;font-size:14px;outline:none;transition:border .2s;
      margin-bottom:16px}
    input:focus{border-color:#3f51b5}
    .btn{width:100%;padding:13px;background:linear-gradient(135deg,#3f51b5,#1a237e);
         color:#fff;border:none;border-radius:12px;font-size:15px;
         font-weight:700;cursor:pointer;transition:opacity .2s;margin-top:4px}
    .btn:hover{opacity:.9}
    .err{background:#ffebee;color:#c62828;padding:11px 14px;
         border-radius:10px;font-size:13px;text-align:center;margin-top:14px}
    @media(max-width:600px){.page{padding:16px 12px}th,td{padding:10px 10px}
      .stats{gap:10px}.stat{padding:16px 16px}}
  </style>
</head>
<body>${body}</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /  — login page
// ══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const errHtml = req.query.error
    ? `<div class="err">❌ Wrong username or password</div>` : '';
  res.send(shell('SMS Dashboard — Login', `
<div class="login-wrap">
  <div class="login-box">
    <div class="ico">🔑</div>
    <h1>SMS Dashboard</h1>
    <p class="sub">Sign in with your app credentials</p>
    <form method="POST" action="/login">
      <label>Username</label>
      <input type="text" name="username" placeholder="Enter username" required autofocus/>
      <label>Password</label>
      <input type="password" name="password" placeholder="Enter password" required/>
      <button class="btn" type="submit">Sign In →</button>
      ${errHtml}
    </form>
  </div>
</div>`));
});

// ══════════════════════════════════════════════════════════════════════════
// POST /login  — validate against Supabase users table
// ══════════════════════════════════════════════════════════════════════════
app.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.redirect('/?error=1');

  try {
    const hashed = hashPassword(password);
    const { data: user } = await supabase
      .from('users')
      .select('id, username, role, is_deactivated')
      .ilike('username', username.trim())
      .eq('password', hashed)
      .maybeSingle();

    if (!user || user.is_deactivated) return res.redirect('/?error=1');

    // Simple signed token: base64(userId|role|timestamp)
    const token = Buffer.from(
      `${user.id}|${user.role}|${user.username}|${Date.now()}`
    ).toString('base64');

    res.redirect(`/dashboard?t=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error('[Login]', e);
    res.redirect('/?error=1');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /dashboard  — main view
// ══════════════════════════════════════════════════════════════════════════
app.get('/dashboard', async (req, res) => {
  const token = req.query.t;
  if (!token) return res.redirect('/');

  let userId, role, username;
  try {
    const decoded = Buffer.from(
      decodeURIComponent(token), 'base64'
    ).toString('utf8');
    [userId, role, username] = decoded.split('|');
    if (!userId || !role) return res.redirect('/');
  } catch { return res.redirect('/'); }

  try {
    // ── Fetch logs from Supabase ──────────────────────────────────────
    let query = supabase
      .from('sms_logs')
      .select('id, user_id, sender, body, timestamp, status, forwarded_to')
      .order('timestamp', { ascending: false })
      .limit(200);

    if (role !== 'admin') {
      query = query.eq('user_id', parseInt(userId));
    }

    const { data: logs, error } = await query;
    if (error) throw error;

    const decrypted = (logs ?? []).map(l => ({
      ...l,
      body: decryptBody(l.body),
    }));

    // ── Stats ─────────────────────────────────────────────────────────
    const total    = decrypted.length;
    const today    = decrypted.filter(l => {
      return new Date(l.timestamp).toDateString() === new Date().toDateString();
    }).length;
    const forwarded = decrypted.filter(l => l.status === 'Forwarded').length;

    // ── Build rows ────────────────────────────────────────────────────
    const rows = decrypted.map(l => {
      const d = new Date(l.timestamp);
      const time = d.toLocaleString('en-GB', {
        day:'2-digit', month:'short', year:'numeric',
        hour:'2-digit', minute:'2-digit'
      });
      const statusPill = l.status === 'Forwarded'
        ? `<span class="pill pill-green">✓ Forwarded</span>`
        : `<span class="pill pill-red">${esc(l.status)}</span>`;
      return `<tr>
        <td><span class="pill pill-blue">#${l.id}</span></td>
        <td><strong>${esc(l.sender)}</strong></td>
        <td class="msg">${esc(l.body)}</td>
        <td>${esc(l.forwarded_to ?? '—')}</td>
        <td>${statusPill}</td>
        <td class="grey">${time}</td>
      </tr>`;
    }).join('');

    const tableBody = rows.length
      ? rows
      : `<tr><td colspan="6" class="empty">
           <div class="ico">📭</div>
           <p>No messages yet</p>
         </td></tr>`;

    const roleLabel = role === 'admin'
      ? `<span class="pill pill-blue">🛡️ Admin</span>`
      : `<span class="pill pill-green">👤 User</span>`;

    const dashHtml = `
<nav>
  <div class="brand">🔑 SMS Dashboard <span>Welcome, ${esc(username)} ${roleLabel}</span></div>
  <a href="/">Sign out</a>
</nav>
<div class="page">
  <div class="stats">
    <div class="stat"><div class="n">${total}</div><div class="l">Total Messages</div></div>
    <div class="stat"><div class="n">${today}</div><div class="l">Today</div></div>
    <div class="stat"><div class="n">${forwarded}</div><div class="l">Forwarded</div></div>
  </div>
  <div class="card">
    <div class="card-head">
      <h2>${role === 'admin' ? 'All Messages' : 'Your Messages'}</h2>
      <span class="hint">Showing latest 200 • <a href="/dashboard?t=${encodeURIComponent(token)}" style="color:#3f51b5;text-decoration:none">↻ Refresh</a></span>
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Sender</th><th>Message</th>
          <th>Forwarded To</th><th>Status</th><th>Time</th>
        </tr>
      </thead>
      <tbody>${tableBody}</tbody>
    </table>
  </div>
</div>`;

    res.send(shell('SMS Dashboard', dashHtml));
  } catch (e) {
    console.error('[Dashboard]', e);
    res.redirect('/');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// API ROUTES (used by Flutter app)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/sms', requireApiSecret, (req, res) => {
  const { sender, body, recipient, username, timestamp } = req.body ?? {};
  const missing = ['sender','body','recipient','username'].filter(f => !req.body?.[f]);
  if (missing.length) {
    return res.status(400).json({ status:'error', message:`Missing: ${missing.join(', ')}` });
  }
  const entry = {
    id: nextId++, sender, body, recipient, username,
    timestamp: timestamp ?? new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
  smsStore.push(entry);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry)+'\n','utf8'); }
    catch(e) { console.error('[Log]', e.message); }
  }
  console.log(`[SMS] #${entry.id} | from=${sender} | to=${recipient} | user=${username} | "${body.slice(0,40)}"`);
  return res.status(200).json({ status:'ok', message:'SMS received', id: entry.id });
});

app.get('/api/sms', requireApiSecret, (req, res) => {
  const { username, limit='50', offset='0' } = req.query;
  let results = username ? smsStore.filter(e => e.username===username) : [...smsStore];
  results.reverse();
  return res.status(200).json({
    status:'ok', total: results.length,
    data: results.slice(Number(offset), Number(offset)+Number(limit))
  });
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', uptime: process.uptime(), stored: smsStore.length, time: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ status:'error', message:'Not found' }));
app.use((err, req, res, _n) => { console.error(err); res.status(500).json({ status:'error', message:'Server error' }); });

app.listen(PORT, () => {
  console.log(`✅  SMS API + Dashboard listening on port ${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/`);
  console.log(`   API       : http://localhost:${PORT}/api/sms`);
  console.log(`   Health    : http://localhost:${PORT}/health`);
});