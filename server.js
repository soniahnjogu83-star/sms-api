'use strict';

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
require('dotenv').config();

const PORT       = parseInt(process.env.PORT ?? '3000', 10);
const API_SECRET = process.env.API_SECRET ?? '';
const LOG_FILE   = process.env.LOG_TO_FILE === 'true'
    ? path.join(__dirname, 'sms_log.jsonl')
    : null;

if (!API_SECRET) {
  console.error('❌  API_SECRET is not set in .env — refusing to start');
  process.exit(1);
}

const smsStore = [];
let nextId = 1;

const app = express();
app.use(express.json());

function requireSecret(req, res, next) {
  const provided = req.headers['x-api-secret'] ?? '';
  if (!provided || provided !== API_SECRET) {
    console.warn(`[Auth] ❌ Rejected request from ${req.ip} — bad secret`);
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
}

app.post('/api/sms', requireSecret, (req, res) => {
  const { sender, body, recipient, username, timestamp } = req.body ?? {};

  const missing = ['sender', 'body', 'recipient', 'username']
      .filter(f => !req.body?.[f]);
  if (missing.length) {
    return res.status(400).json({
      status:  'error',
      message: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  const entry = {
    id:         nextId++,
    sender,
    body,
    recipient,
    username,
    timestamp:  timestamp ?? new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };

  smsStore.push(entry);

  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      console.error('[Log] Failed to write to file:', e.message);
    }
  }

  console.log(
    `[SMS] #${entry.id} | from=${sender} | to=${recipient}` +
    ` | user=${username} | "${body.slice(0, 40)}${body.length > 40 ? '…' : ''}"`
  );

  return res.status(200).json({ status: 'ok', message: 'SMS received', id: entry.id });
});

app.get('/api/sms', requireSecret, (req, res) => {
  const { username, limit = '50', offset = '0' } = req.query;
  let results = username
      ? smsStore.filter(e => e.username === username)
      : [...smsStore];

  results.reverse();

  const total  = results.length;
  const sliced = results.slice(Number(offset), Number(offset) + Number(limit));

  return res.status(200).json({
    status: 'ok',
    total,
    offset: Number(offset),
    limit:  Number(limit),
    data:   sliced,
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status:  'ok',
    uptime:  process.uptime(),
    stored:  smsStore.length,
    time:    new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Not found' });
});

app.use((err, req, res, _next) => {
  console.error('[Error]', err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅  SMS Receiver API listening on port ${PORT}`);
  console.log(`   POST  http://localhost:${PORT}/api/sms`);
  console.log(`   GET   http://localhost:${PORT}/api/sms`);
  console.log(`   GET   http://localhost:${PORT}/health`);
  if (LOG_FILE) console.log(`   Logging to ${LOG_FILE}`);
});
