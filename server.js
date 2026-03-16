'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const PORT         = parseInt(process.env.PORT ?? '3000', 10);
const API_SECRET   = process.env.API_SECRET ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const LOG_FILE     = process.env.LOG_TO_FILE === 'true'
    ? path.join(__dirname, 'sms_log.jsonl') : null;

if (!API_SECRET)   { console.error('❌ API_SECRET not set');       process.exit(1); }
if (!SUPABASE_URL) { console.error('❌ SUPABASE_URL not set');     process.exit(1); }
if (!SUPABASE_KEY) { console.error('❌ SUPABASE_ANON_KEY not set');process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const smsStore = [];
let nextId = 1;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function hashPassword(password) {
  const crypto = require('crypto');
  const salt   = 'sms_fwd_salt_7x9k2p_2025';
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function decryptBody(encrypted) {
  try {
    const key      = 'sms_fwd_enc_key_x9k2025';
    const keyBytes = Buffer.from(key);
    const encBytes = Buffer.from(encrypted, 'base64');
    const out      = Buffer.alloc(encBytes.length);
    for (let i = 0; i < encBytes.length; i++) {
      out[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    return out.toString('utf8');
  } catch { return encrypted; }
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}

function requireApiSecret(req, res, next) {
  if ((req.headers['x-api-secret'] ?? '') !== API_SECRET)
    return res.status(401).json({ status:'error', message:'Unauthorized' });
  next();
}

// ── Initial letter avatar colour (deterministic) ─────────────────────────
function avatarColor(name) {
  const colors = ['#3f51b5','#e91e63','#009688','#ff5722',
                  '#9c27b0','#f44336','#2196f3','#4caf50'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

// ══════════════════════════════════════════════════════════════════════════
// HTML SHELL
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

/* ── NAV ── */
nav{background:linear-gradient(135deg,#1a237e,#283593);color:#fff;
    padding:16px 28px;display:flex;align-items:center;
    justify-content:space-between;box-shadow:0 2px 14px rgba(0,0,0,.25)}
nav .brand{font-size:18px;font-weight:800}
nav .brand span{opacity:.65;font-weight:400;font-size:13px;margin-left:8px}
nav a{color:#fff;text-decoration:none;font-size:13px;
      background:rgba(255,255,255,.15);padding:6px 16px;
      border-radius:20px;transition:background .2s}
nav a:hover{background:rgba(255,255,255,.28)}

/* ── PAGE ── */
.page{max-width:820px;margin:0 auto;padding:28px 18px}

/* ── STATS ── */
.stats{display:flex;gap:14px;margin-bottom:26px;flex-wrap:wrap}
.stat{background:#fff;border-radius:14px;padding:18px 22px;flex:1;
      min-width:120px;box-shadow:0 2px 10px rgba(0,0,0,.07)}
.stat .n{font-size:32px;font-weight:900;color:#3f51b5}
.stat .l{font-size:12px;color:#aaa;margin-top:2px}

/* ── SECTION HEADER ── */
.section-title{font-size:15px;font-weight:700;margin-bottom:14px;
               color:#333;padding-left:2px}

/* ── SENDER CARD ── */
.sender-card{background:#fff;border-radius:18px;
             box-shadow:0 2px 10px rgba(0,0,0,.07);
             margin-bottom:14px;overflow:hidden}

.card-trigger{display:flex;align-items:center;padding:16px 18px;
              cursor:pointer;user-select:none;transition:background .15s;
              gap:14px}
.card-trigger:hover{background:#f9f9ff}

.avatar{width:44px;height:44px;border-radius:50%;display:flex;
        align-items:center;justify-content:center;
        font-size:18px;font-weight:800;color:#fff;flex-shrink:0}

.card-meta{flex:1;min-width:0}
.card-meta .sender-name{font-size:15px;font-weight:700;
                        white-space:nowrap;overflow:hidden;
                        text-overflow:ellipsis}
.card-meta .last-msg{font-size:12px;color:#aaa;margin-top:2px;
                     white-space:nowrap;overflow:hidden;
                     text-overflow:ellipsis;max-width:340px}

.card-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.count-badge{background:#e8eaf6;color:#3f51b5;padding:3px 10px;
             border-radius:20px;font-size:11px;font-weight:700;
             white-space:nowrap}
.chevron{font-size:18px;color:#ccc;transition:transform .25s}
.chevron.open{transform:rotate(180deg)}

/* ── MESSAGES LIST ── */
.messages{display:none;border-top:1px solid #f0f0f0}
.messages.open{display:block}

.msg-item{padding:14px 18px 14px 76px;border-bottom:1px solid #f7f7f7;
          position:relative}
.msg-item:last-child{border:none}

.msg-body{font-size:13px;line-height:1.55;color:#333;
          background:#f8f9ff;border:1px solid #e8eaf6;
          border-radius:10px;padding:10px 13px;
          font-family:'Courier New',monospace;
          word-break:break-word;margin-bottom:8px}

.msg-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.msg-time{font-size:11px;color:#bbb}
.msg-fwd{font-size:11px;color:#aaa}
.pill{display:inline-block;padding:2px 9px;border-radius:20px;
      font-size:10px;font-weight:700}
.pill-green{background:#e8f5e9;color:#2e7d32}
.pill-orange{background:#fff3e0;color:#e65100}

/* ── LOGIN ── */
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
  border-radius:12px;font-size:14px;outline:none;
  transition:border .2s;margin-bottom:16px}
input:focus{border-color:#3f51b5}
.btn{width:100%;padding:13px;
     background:linear-gradient(135deg,#3f51b5,#1a237e);
     color:#fff;border:none;border-radius:12px;font-size:15px;
     font-weight:700;cursor:pointer;transition:opacity .2s;margin-top:4px}
.btn:hover{opacity:.9}
.err{background:#ffebee;color:#c62828;padding:11px 14px;
     border-radius:10px;font-size:13px;text-align:center;margin-top:14px}

/* ── EMPTY ── */
.empty-state{text-align:center;padding:60px 20px;color:#ccc}
.empty-state .ico{font-size:48px;margin-bottom:12px}
.empty-state p{font-size:14px}

@media(max-width:600px){
  .page{padding:16px 12px}
  .stats{gap:10px}.stat{padding:14px 16px}
  .msg-item{padding-left:18px}
}
</style>
</head>
<body>${body}
<script>
// Accordion toggle
document.querySelectorAll('.card-trigger').forEach(trigger => {
  trigger.addEventListener('click', () => {
    const card     = trigger.closest('.sender-card');
    const messages = card.querySelector('.messages');
    const chevron  = trigger.querySelector('.chevron');
    const isOpen   = messages.classList.contains('open');
    messages.classList.toggle('open', !isOpen);
    chevron.classList.toggle('open', !isOpen);
  });
});
</script>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /  — login
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
      <input type="text" name="username" placeholder="Enter username"
             required autofocus/>
      <label>Password</label>
      <input type="password" name="password" placeholder="Enter password"
             required/>
      <button class="btn" type="submit">Sign In →</button>
      ${errHtml}
    </form>
  </div>
</div>`));
});

// ══════════════════════════════════════════════════════════════════════════
// POST /login
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
// GET /dashboard  — grouped by sender cards
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
    // ── Fetch logs ────────────────────────────────────────────────────
    let query = supabase
      .from('sms_logs')
      .select('id, user_id, sender, body, timestamp, status, forwarded_to')
      .order('timestamp', { ascending: false })
      .limit(500);

    if (role !== 'admin') query = query.eq('user_id', parseInt(userId));

    const { data: logs, error } = await query;
    if (error) throw error;

    const decrypted = (logs ?? []).map(l => ({
      ...l, body: decryptBody(l.body)
    }));

    // ── Group by sender ───────────────────────────────────────────────
    const grouped = {};
    for (const l of decrypted) {
      if (!grouped[l.sender]) grouped[l.sender] = [];
      grouped[l.sender].push(l);
    }

    // Sort senders by most recent message first
    const senders = Object.keys(grouped).sort((a, b) => {
      return new Date(grouped[b][0].timestamp) -
             new Date(grouped[a][0].timestamp);
    });

    // ── Stats ─────────────────────────────────────────────────────────
    const total     = decrypted.length;
    const today     = decrypted.filter(l =>
      new Date(l.timestamp).toDateString() === new Date().toDateString()
    ).length;
    const forwarded = decrypted.filter(l => l.status === 'Forwarded').length;

    // ── Build sender cards ────────────────────────────────────────────
    let cardsHtml = '';

    if (senders.length === 0) {
      cardsHtml = `
        <div class="empty-state">
          <div class="ico">📭</div>
          <p>No messages yet.<br>
             <span style="font-size:12px;color:#ddd">
               Messages will appear here once your app forwards an OTP.
             </span>
          </p>
        </div>`;
    } else {
      for (const sender of senders) {
        const msgs     = grouped[sender];
        const count    = msgs.length;
        const latest   = msgs[0];
        const color    = avatarColor(sender);
        const initial  = sender.charAt(0).toUpperCase();
        const preview  = latest.body.length > 60
          ? latest.body.slice(0, 60) + '…' : latest.body;

        // Build individual message rows
        const msgRows = msgs.map(m => {
          const isFwd = m.status === 'Forwarded';
          const pill  = isFwd
            ? `<span class="pill pill-green">✓ Forwarded</span>`
            : `<span class="pill pill-orange">${esc(m.status)}</span>`;
          const fwdLine = m.forwarded_to
            ? `<span class="msg-fwd">→ ${esc(m.forwarded_to)}</span>` : '';
          return `
            <div class="msg-item">
              <div class="msg-body">${esc(m.body)}</div>
              <div class="msg-footer">
                ${pill}
                <span class="msg-time">🕐 ${fmtTime(m.timestamp)}</span>
                ${fwdLine}
              </div>
            </div>`;
        }).join('');

        cardsHtml += `
          <div class="sender-card">
            <div class="card-trigger">
              <div class="avatar" style="background:${color}">${initial}</div>
              <div class="card-meta">
                <div class="sender-name">${esc(sender)}</div>
                <div class="last-msg">${esc(preview)}</div>
              </div>
              <div class="card-right">
                <span class="count-badge">${count} OTP${count > 1 ? 's' : ''}</span>
                <span class="chevron">▾</span>
              </div>
            </div>
            <div class="messages">
              ${msgRows}
            </div>
          </div>`;
      }
    }

    const roleLabel = role === 'admin'
      ? `<span style="background:rgba(255,255,255,.2);padding:3px 10px;
                      border-radius:20px;font-size:12px">🛡️ Admin</span>`
      : `<span style="background:rgba(255,255,255,.2);padding:3px 10px;
                      border-radius:20px;font-size:12px">👤 User</span>`;

    const dashHtml = `
<nav>
  <div class="brand">
    🔑 SMS Dashboard
    <span>Welcome, ${esc(username)} ${roleLabel}</span>
  </div>
  <a href="/">Sign out</a>
</nav>
<div class="page">
  <div class="stats">
    <div class="stat"><div class="n">${total}</div><div class="l">Total</div></div>
    <div class="stat"><div class="n">${today}</div><div class="l">Today</div></div>
    <div class="stat"><div class="n">${forwarded}</div><div class="l">Forwarded</div></div>
    <div class="stat"><div class="n">${senders.length}</div><div class="l">Senders</div></div>
  </div>

  <div class="section-title">
    ${role === 'admin' ? 'All Messages' : 'Your Messages'}
    &nbsp;—&nbsp;
    <a href="/dashboard?t=${encodeURIComponent(token)}"
       style="color:#3f51b5;text-decoration:none;font-size:13px;font-weight:400">
      ↻ Refresh
    </a>
  </div>

  ${cardsHtml}
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
  const missing = ['sender','body','recipient','username']
    .filter(f => !req.body?.[f]);
  if (missing.length)
    return res.status(400).json({ status:'error',
      message:`Missing: ${missing.join(', ')}` });

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
  console.log(`[SMS] #${entry.id} | from=${sender} | to=${recipient}` +
    ` | user=${username} | "${body.slice(0,40)}"`);
  return res.status(200).json({ status:'ok', message:'SMS received',
    id: entry.id });
});

app.get('/api/sms', requireApiSecret, (req, res) => {
  const { username, limit='50', offset='0' } = req.query;
  let results = username
    ? smsStore.filter(e => e.username === username)
    : [...smsStore];
  results.reverse();
  return res.status(200).json({
    status:'ok', total: results.length,
    data: results.slice(Number(offset), Number(offset)+Number(limit))
  });
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', uptime: process.uptime(),
    stored: smsStore.length, time: new Date().toISOString() });
});

app.use((req, res) =>
  res.status(404).json({ status:'error', message:'Not found' }));
app.use((err, req, res, _n) => {
  console.error(err);
  res.status(500).json({ status:'error', message:'Server error' });
});

app.listen(PORT, () => {
  console.log(`✅  SMS API + Dashboard on port ${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/`);
  console.log(`   API       : http://localhost:${PORT}/api/sms`);
  console.log(`   Health    : http://localhost:${PORT}/health`);
});