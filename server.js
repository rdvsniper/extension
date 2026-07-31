// ═══════════════════════════════════════════════════════════════════════════
//  RDV SNIPER Admin API Server v4.0 — Node.js replacement for Cloudflare Worker
//  Deploy to Render.com as a FREE Web Service
//
//  Optional: Set these 2 env vars in Render for persistent data (Upstash Redis):
//    UPSTASH_REDIS_REST_URL   = https://your-db.upstash.io
//    UPSTASH_REDIS_REST_TOKEN = your_token
//  Without them, data is kept in-memory (resets on restart, but clients re-register automatically)
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const app     = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ── CORS ─────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── UPSTASH REDIS (optional, free at upstash.com) ────────────────────────
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH   = !!(UPSTASH_URL && UPSTASH_TOKEN);

// ── FALLBACK IN-MEMORY STORE ──────────────────────────────────────────────
const MEM = {};

const KV = {
  async get(key) {
    if (USE_UPSTASH) {
      try {
        const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
          { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
        const d = await r.json();
        return d.result ?? null;
      } catch { return null; }
    }
    return MEM[key] ?? null;
  },
  async set(key, value, ttlSeconds) {
    if (USE_UPSTASH) {
      try {
        const path = ttlSeconds
          ? `/set/${encodeURIComponent(key)}?ex=${ttlSeconds}`
          : `/set/${encodeURIComponent(key)}`;
        await fetch(`${UPSTASH_URL}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
          body: value,
        });
      } catch { return false; }
      return true;
    }
    MEM[key] = value;
    if (ttlSeconds) setTimeout(() => delete MEM[key], ttlSeconds * 1000);
    return true;
  },
  async del(key) {
    if (USE_UPSTASH) {
      try {
        await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        });
      } catch {}
      return true;
    }
    delete MEM[key];
    return true;
  },
  async keys(prefix) {
    if (USE_UPSTASH) {
      try {
        const r = await fetch(`${UPSTASH_URL}/keys/${encodeURIComponent(prefix + '*')}`,
          { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
        const d = await r.json();
        return d.result ?? [];
      } catch { return []; }
    }
    return Object.keys(MEM).filter(k => k.startsWith(prefix));
  },
};

// ── USER HELPERS ──────────────────────────────────────────────────────────
async function getUser(machineId) {
  const raw = await KV.get(`user:${machineId}`);
  if (raw) try { return JSON.parse(raw); } catch {}
  return { chatId: machineId, username: '', plan: 'N/A', status: 'pending', joinedAt: Date.now(), lastSeen: Date.now(), messageCount: 0, notes: '' };
}

async function saveUser(user, force = false) {
  const now = Date.now();
  user.lastSeen = now;
  if (!force && user._lastSaved && (now - user._lastSaved < 5 * 60 * 1000)) return true;
  user._lastSaved = now;
  return KV.set(`user:${user.chatId}`, JSON.stringify(user));
}

async function getAllUsers() {
  const keys = await KV.keys('user:');
  const users = [];
  for (const key of keys) {
    const raw = await KV.get(key);
    if (raw) try { users.push(JSON.parse(raw)); } catch {}
  }
  return users.sort((a, b) => b.lastSeen - a.lastSeen);
}

// ── CHAT HELPERS ──────────────────────────────────────────────────────────
async function storeChatMessage(machineId, from, text) {
  const key = `chat:${machineId}`;
  let history = [];
  const raw = await KV.get(key);
  if (raw) try { history = JSON.parse(raw); } catch {}
  history.push({ from, text, ts: Date.now() });
  if (history.length > 200) history = history.slice(-200);
  return KV.set(key, JSON.stringify(history), 7 * 86400);
}

async function getChatHistory(machineId) {
  const raw = await KV.get(`chat:${machineId}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// ── ADMIN MESSAGE QUEUE ───────────────────────────────────────────────────
async function storeAdminMessage(machineId, text) {
  const key = `msg:${machineId}`;
  let queue = [];
  const raw = await KV.get(key);
  if (raw) try { queue = JSON.parse(raw); } catch {}
  queue.push({ id: Date.now(), text, ts: Date.now() });
  if (queue.length > 50) queue = queue.slice(-50);
  return KV.set(key, JSON.stringify(queue), 86400);
}

async function drainAdminMessages(machineId) {
  const key = `msg:${machineId}`;
  const raw = await KV.get(key);
  if (!raw) return [];
  let queue = [];
  try { queue = JSON.parse(raw); } catch {}
  await KV.del(key);
  return queue;
}

// ── LICENSE HELPERS ───────────────────────────────────────────────────────
const SECRET_KEY = process.env.TOKEN_SECRET || 'rdvsniper-secret-key-2025';

async function generateToken(machineId, days, plan) {
  const expiry  = Date.now() + days * 86400 * 1000;
  const payload = { machineId, expiry, plan, v: 2 };
  const b64     = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac    = crypto.createHmac('sha256', SECRET_KEY).update(b64).digest('hex');
  return { token: `SNIPER-V2|${b64}|${hmac}`, expires: expiry, plan };
}

async function storeRemoteLicense(machineId, token, expires, plan) {
  return KV.set(`license:${machineId}`, JSON.stringify({ machineId, token, expires, plan, status: 'active', updatedAt: Date.now() }));
}

async function getRemoteLicense(machineId) {
  const raw = await KV.get(`license:${machineId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'admin-portal.html'));
  }
  res.json({ ok: true, service: 'RDV SNIPER Admin API', version: '4.0.0', storage: USE_UPSTASH ? 'upstash' : 'memory' });
});

// /register — Extension heartbeat
app.post('/register', async (req, res) => {
  try {
    const { machineId, username, plan } = req.body;
    if (!machineId) return res.json({ ok: false, error: 'machineId required' });
    const user = await getUser(machineId);
    const isNew = !user._lastSaved;
    if (username && username !== 'User' && username !== 'Client User') user.username = username.trim();
    else if (!user.username) user.username = username || 'Client';
    if (plan && plan !== 'N/A') user.plan = plan;
    await saveUser(user, isNew);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /send — Client sends message to admin
app.post('/send', async (req, res) => {
  try {
    const { machineId, username, plan, text } = req.body;
    if (!machineId || !text) return res.json({ ok: false, error: 'machineId and text required' });
    await storeChatMessage(machineId, 'client', text);
    const user = await getUser(machineId);
    if (username && username !== 'User' && username !== 'Client User') user.username = username.trim();
    else if (!user.username) user.username = username || 'Client';
    if (plan && plan !== 'N/A') user.plan = plan;
    user.lastMessage   = text;
    user.lastMessageTs = Date.now();
    user.unread        = (user.unread || 0) + 1;
    user.messageCount  = (user.messageCount || 0) + 1;
    await saveUser(user, true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /poll — Extension polls for admin messages
app.get('/poll', async (req, res) => {
  try {
    const { machineId } = req.query;
    if (!machineId) return res.json({ ok: false, error: 'machineId required' });
    const messages = await drainAdminMessages(machineId);
    res.json({ ok: true, messages });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /license-sync — Extension checks license
app.get('/license-sync', async (req, res) => {
  try {
    const { machineId, username, plan } = req.query;
    if (!machineId) return res.json({ ok: false, error: 'machineId required' });
    const user = await getUser(machineId);
    const isNew = !user._lastSaved;
    if (username && username !== 'User' && username !== 'Client User') user.username = username;
    else if (!user.username) user.username = 'Client';
    if (plan && plan !== 'N/A') user.plan = plan;
    await saveUser(user, isNew);
    if (user.status === 'blocked') return res.json({ ok: true, active: false, blocked: true });
    const license = await getRemoteLicense(machineId);
    if (license && license.status === 'blocked') return res.json({ ok: true, active: false, blocked: true });
    if (!license || license.expires <= Date.now()) return res.json({ ok: true, active: false, blocked: false });
    res.json({ ok: true, active: true, blocked: false, license });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /admin/api/users
app.get('/admin/api/users', async (req, res) => {
  try {
    const users = await getAllUsers();
    const now   = Date.now();
    res.json({ ok: true, users, onlineCount: users.filter(u => now - u.lastSeen < 10 * 60 * 1000).length, kvConfigured: true });
  } catch (e) { res.json({ ok: true, users: [], onlineCount: 0, error: e.message }); }
});

// /admin/api/debug
app.get('/admin/api/debug', async (req, res) => {
  try {
    const users    = await getAllUsers();
    const chatKeys = await KV.keys('chat:');
    res.json({
      ok: true, workerVersion: '4.0.0-node',
      kvConnected: true, activeKvBinding: USE_UPSTASH ? 'UPSTASH_REDIS' : 'MEMORY',
      kvBindingStatus: { UPSTASH_REDIS: USE_UPSTASH, MEMORY: !USE_UPSTASH },
      userCount: users.length, chatCount: chatKeys.length, timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /admin/api/chat AND /admin/api/chats (support both singular and plural)
app.get(['/admin/api/chat', '/admin/api/chats'], async (req, res) => {
  try {
    const { machineId } = req.query;
    if (!machineId) return res.json({ ok: false, error: 'machineId required' });
    const user = await getUser(machineId);
    if (user && user.unread) {
      user.unread = 0;
      await saveUser(user, true);
    }
    res.json({ ok: true, messages: await getChatHistory(machineId) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /admin/api/reply — Admin sends message to client
app.post('/admin/api/reply', async (req, res) => {
  try {
    const { machineId, text } = req.body;
    if (!machineId || !text) return res.json({ ok: false, error: 'machineId and text required' });
    await storeChatMessage(machineId, 'admin', text);
    await storeAdminMessage(machineId, text);
    const user  = await getUser(machineId);
    user.unread = 0;
    await saveUser(user, true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /admin/api/activate — Remote license activation
app.post('/admin/api/activate', async (req, res) => {
  try {
    const { machineId, days } = req.body;
    if (!machineId || !days || days <= 0) return res.json({ ok: false, error: 'machineId and days required' });
    const plan = days <= 7 ? '7 Days' : days <= 30 ? '1 Month' : '3 Months';
    const { token, expires } = await generateToken(machineId, parseInt(days), plan);
    await storeRemoteLicense(machineId, token, expires, plan);
    const user = await getUser(machineId);
    user.status = 'active';
    user.tokenExpires = expires;
    user.plan = plan;
    await saveUser(user, true);
    res.json({ ok: true, token, expires, plan });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /admin/api/block
app.post('/admin/api/block', async (req, res) => {
  try {
    const { machineId, action } = req.body;
    if (!machineId || !['block', 'unblock'].includes(action)) return res.json({ ok: false, error: 'Invalid params' });
    const user = await getUser(machineId);
    const lic  = await getRemoteLicense(machineId);
    if (action === 'block') {
      user.status = 'blocked';
      if (lic) { lic.status = 'blocked'; await storeRemoteLicense(machineId, lic.token, lic.expires, lic.plan); }
      await storeAdminMessage(machineId, '⛔ YOUR ACCESS HAS BEEN REVOKED BY ADMIN.');
    } else {
      user.status = (lic && lic.expires > Date.now()) ? 'active' : 'pending';
      if (lic && lic.status === 'blocked') { lic.status = 'active'; await storeRemoteLicense(machineId, lic.token, lic.expires, lic.plan); }
    }
    await saveUser(user, true);
    res.json({ ok: true, status: user.status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /store-msg
app.post(['/store-msg', '/reply-to-machine'], async (req, res) => {
  try {
    const { machineId, text } = req.body;
    if (!machineId || !text) return res.json({ ok: false, error: 'machineId and text required' });
    await storeAdminMessage(machineId, text);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RDV SNIPER Admin API v4.0 running on port ${PORT}`);
  console.log(`Storage: ${USE_UPSTASH ? 'Upstash Redis (persistent)' : 'In-Memory (resets on restart)'}`);
});

