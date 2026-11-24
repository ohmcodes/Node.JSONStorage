const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { jsonrepair } = require('jsonrepair');
require('dotenv').config();

const BIN_LIMIT = 100 * 1024;
const ACCOUNT_LIMIT = 10 * 1024 * 1024;
const REQUEST_LIMIT = 10000;
const BODY_LIMIT = 1024 * 1024;

function createServer({
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  binInactivityMs = 30 * 24 * 60 * 60 * 1000,
  binCleanupIntervalMs = 60 * 60 * 1000,
  liveLogIdleMs = 5 * 60 * 1000,
  liveLogSessionMs = 10 * 60 * 1000,
  liveLogSubscriberLimit = 20
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const accountsFile = path.join(dataDir, 'accounts.json');
  const binsDir = path.join(dataDir, 'bins');
  const legacyFile = path.join(dataDir, 'storage.json');
  fs.mkdirSync(binsDir, { recursive: true, mode: 0o700 });

  function writeJson(file, value) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function binFile(id) {
    return path.join(binsDir, `${id}.json`);
  }

  const legacy = fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8')) : null;
  const accounts = fs.existsSync(accountsFile)
    ? JSON.parse(fs.readFileSync(accountsFile, 'utf8'))
    : legacy ? legacy.accounts || {} : {};

  if (legacy && legacy.bins) {
    for (const [id, bin] of Object.entries(legacy.bins)) {
      if (/^[a-f0-9]{32}$/.test(id) && !fs.existsSync(binFile(id))) {
        writeJson(binFile(id), { ...bin, lastAccessedAt: bin.lastAccessedAt ?? Date.now() });
      }
    }
    if (!fs.existsSync(accountsFile)) writeJson(accountsFile, accounts);
    let archiveFile = `${legacyFile}.migrated`;
    let suffix = 1;
    while (fs.existsSync(archiveFile)) archiveFile = `${legacyFile}.migrated-${suffix++}`;
    fs.renameSync(legacyFile, archiveFile);
  } else if (!fs.existsSync(accountsFile)) {
    writeJson(accountsFile, accounts);
  }

  function persistAccounts() {
    writeJson(accountsFile, accounts);
  }

  function reconcileAccountBytes() {
    const previousBytes = new Map();
    for (const [owner, account] of Object.entries(accounts)) {
      previousBytes.set(owner, account.bytes || 0);
      account.bytes = 0;
    }
    for (const name of fs.readdirSync(binsDir)) {
      const match = /^([a-f0-9]{32})\.json$/.exec(name);
      if (!match) continue;
      const bin = JSON.parse(fs.readFileSync(path.join(binsDir, name), 'utf8'));
      const account = accounts[bin.owner];
      if (!account) continue;
      account.bytes += Number.isSafeInteger(bin.bytes)
        ? bin.bytes
        : Buffer.byteLength(JSON.stringify(bin.value));
    }
    if (Object.entries(accounts).some(([owner, account]) => previousBytes.get(owner) !== account.bytes)) {
      persistAccounts();
    }
  }

  reconcileAccountBytes();

  function persistBin(id, bin) {
    writeJson(binFile(id), bin);
  }

  function removeBinFile(id) {
    fs.rmSync(binFile(id), { force: true });
  }

  function readBin(id) {
    const file = binFile(id);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  function cleanupInactiveBins(now = Date.now()) {
    let accountsChanged = false;
    for (const name of fs.readdirSync(binsDir)) {
      const match = /^([a-f0-9]{32})\.json$/.exec(name);
      if (!match) continue;
      const file = path.join(binsDir, name);
      let bin;
      try {
        bin = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const lastAccessedAt = Number.isFinite(bin.lastAccessedAt)
        ? bin.lastAccessedAt
        : fs.statSync(file).mtimeMs;
      if (now - lastAccessedAt < binInactivityMs) continue;
      removeBinFile(match[1]);
      const account = accounts[bin.owner];
      if (account) {
        const bytes = Number.isSafeInteger(bin.bytes)
          ? bin.bytes
          : Buffer.byteLength(JSON.stringify(bin.value));
        account.bytes = Math.max(0, account.bytes - bytes);
        accountsChanged = true;
      }
    }
    if (accountsChanged) persistAccounts();
  }

  cleanupInactiveBins();

  const activityLog = [];
  const logSubscribers = new Map();
  const activityLimit = 200;

  function recordActivity(req, status, value) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/api/') || pathname === '/api/live-logs') return;
    const binMatch = /^\/api\/bins\/([a-f0-9]{32})$/.exec(pathname);
    const responseBinId = value && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)
      ? value.id
      : null;
    const candidateBinId = responseBinId || (binMatch && binMatch[1]);
    const isPublicBin = req.binVisibility === 'public' || (value && value.visibility === 'public');
    const event = {
      timestamp: new Date().toISOString(),
      method: req.method,
      endpoint: binMatch && !isPublicBin ? '/api/bins/[redacted]' : pathname,
      status,
      durationMs: Date.now() - req.startedAt,
      binId: isPublicBin ? candidateBinId : null
    };
    activityLog.push(event);
    if (activityLog.length > activityLimit) activityLog.shift();
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const [subscriber, state] of logSubscribers) {
      state.lastActivityAt = Date.now();
      subscriber.write(line);
    }
  }

  function send(req, res, status, value) {
    recordActivity(req, status, value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }

  function parse(text) {
    try { return JSON.parse(text); } catch { fail(400, 'Invalid JSON'); }
  }

  function size(value) {
    return Buffer.byteLength(JSON.stringify(value));
  }

  function accountFor(req) {
    const key = req.headers['x-secret-key'];
    if (typeof key === 'string' && key.trim()) {
      if (!/^[a-f0-9]{64}$/.test(key.trim())) return null;
      return crypto.createHash('sha256').update(key.trim()).digest('hex');
    }
    const cookie = req.headers.cookie || '';
    const ownerCookie = /(?:^|;\s*)bin_owner=([a-f0-9]{64})(?:;|$)/.exec(cookie);
    return ownerCookie ? crypto.createHash('sha256').update(ownerCookie[1]).digest('hex') : null;
  }

  function hasSecretKey(req) {
    const key = req.headers['x-secret-key'];
    return typeof key === 'string' && key.trim().length > 0;
  }

  function charge(account) {
    const month = new Date().toISOString().slice(0, 7);
    if (account.month !== month) {
      account.month = month;
      account.requests = 0;
    }
    if (account.requests >= REQUEST_LIMIT) fail(429, 'Monthly request limit reached');
    account.requests++;
  }

  function checkSize(value, account, previous = 0) {
    const bytes = size(value);
    if (bytes > BIN_LIMIT) fail(413, 'Bin exceeds 100 KB');
    if (account.bytes - previous + bytes > ACCOUNT_LIMIT) fail(413, 'Account exceeds 10 MB quota');
    return bytes;
  }

  async function body(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > BODY_LIMIT) fail(413, 'Request body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    req.startedAt = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css';
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', name)));
      }

      if (req.method === 'GET' && url.pathname === '/api/live-logs') {
        if (logSubscribers.size >= liveLogSubscriberLimit) {
          return send(req, res, 503, { error: 'Live log viewer is at capacity. Try again shortly.' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write('retry: 3000\n\n');
        for (const event of activityLog) res.write(`data: ${JSON.stringify(event)}\n\n`);
        const state = { startedAt: Date.now(), lastActivityAt: Date.now() };
        logSubscribers.set(res, state);
        const heartbeatDelay = Math.max(10, Math.min(15000, liveLogIdleMs / 4, liveLogSessionMs / 4));
        const heartbeat = setInterval(() => {
          const now = Date.now();
          if (now - state.startedAt >= liveLogSessionMs) {
            res.end(`event: stopped\ndata: ${JSON.stringify({ reason: 'session-limit' })}\n\n`);
          } else if (now - state.lastActivityAt >= liveLogIdleMs) {
            res.end(`event: stopped\ndata: ${JSON.stringify({ reason: 'inactive' })}\n\n`);
          } else {
            res.write(': keep-alive\n\n');
          }
        }, heartbeatDelay);
        heartbeat.unref();
        res.on('close', () => {
          clearInterval(heartbeat);
          logSubscribers.delete(res);
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const key = crypto.randomBytes(32).toString('hex');
        const owner = crypto.createHash('sha256').update(key).digest('hex');
        accounts[owner] = { bytes: 0, month: '', requests: 0 };
        persistAccounts();
        return send(req, res, 201, { secretKey: key });
      }

      if (req.method === 'POST' && url.pathname === '/api/repair') {
        const text = await body(req);
        try {
          return send(req, res, 200, { json: JSON.stringify(JSON.parse(jsonrepair(text)), null, 2) });
        } catch {
          return send(req, res, 400, { error: 'Unable to repair JSON' });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/bins') {
        const visibility = url.searchParams.get('visibility') || 'public';
        if (!['public', 'private'].includes(visibility)) fail(400, 'Visibility must be public or private');
        req.binVisibility = visibility;
        const keyProvided = hasSecretKey(req);
        let owner = accountFor(req);
        let account = owner ? accounts[owner] : null;
        let newOwnerCookie = null;
        if (visibility === 'private' && !keyProvided) fail(401, 'Valid secret key required');
        if (keyProvided && !account) fail(401, 'Valid secret key required');
        const value = parse(await body(req));
        if (!account && visibility === 'public') {
          newOwnerCookie = crypto.randomBytes(32).toString('hex');
          owner = crypto.createHash('sha256').update(newOwnerCookie).digest('hex');
          account = accounts[owner] = { bytes: 0, month: '', requests: 0 };
        }
        const bytes = checkSize(value, account);
        charge(account);
        const id = crypto.randomBytes(16).toString('hex');
        const bin = { owner, visibility, value, bytes, lastAccessedAt: Date.now() };
        account.bytes += bytes;
        persistBin(id, bin);
        persistAccounts();
        if (newOwnerCookie) {
          res.setHeader('Set-Cookie', `bin_owner=${newOwnerCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
        }
        return send(req, res, 201, { id, visibility });
      }

      const match = /^\/api\/bins\/([a-f0-9]{32})$/.exec(url.pathname);
      if (!match) fail(404, 'Not found');
      if (!['GET', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) fail(405, 'Method not allowed');
      const bin = readBin(match[1]);
      if (!bin) fail(404, 'Not found');
      req.binVisibility = bin.visibility;
      const owner = accountFor(req);
      if ((bin.visibility === 'private' || req.method !== 'GET') && owner !== bin.owner) {
        fail(401, 'Valid secret key required');
      }
      const account = accounts[bin.owner];
      if (req.method === 'GET') {
        charge(account);
        bin.lastAccessedAt = Date.now();
        persistBin(match[1], bin);
        persistAccounts();
        return send(req, res, 200, bin.value);
      }
      if (req.method === 'DELETE') {
        charge(account);
        account.bytes -= bin.bytes;
        removeBinFile(match[1]);
        persistAccounts();
        return send(req, res, 200, { deleted: true });
      }
      let value = parse(await body(req));
      if (req.method === 'PATCH') {
        if (!value || Array.isArray(value) || typeof value !== 'object' ||
            !bin.value || Array.isArray(bin.value) || typeof bin.value !== 'object') {
          fail(400, 'PATCH requires JSON objects');
        }
        value = { ...bin.value, ...value };
      }
      const bytes = checkSize(value, account, bin.bytes);
      charge(account);
      account.bytes += bytes - bin.bytes;
      bin.value = value;
      bin.bytes = bytes;
      bin.lastAccessedAt = Date.now();
      persistBin(match[1], bin);
      persistAccounts();
      return send(req, res, 200, bin.value);
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) send(req, res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
      else res.destroy();
    }
  });
  const cleanupTimer = setInterval(cleanupInactiveBins, binCleanupIntervalMs);
  cleanupTimer.unref();
  server.on('close', () => clearInterval(cleanupTimer));
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  createServer({ dataDir }).listen(port, host, () => {
    console.log(`JSON Storage listening on http://${host}:${port}`);
    console.log(`JSON Storage data directory: ${dataDir}`);
  });
}

module.exports = { createServer };
