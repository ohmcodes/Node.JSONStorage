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
    let accountsChanged = false;
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
    for (const [owner, account] of Object.entries(accounts)) {
      if (account.ephemeral && account.bytes === 0) {
        delete accounts[owner];
        accountsChanged = true;
      }
    }
    if (accountsChanged || Object.entries(accounts).some(([owner, account]) => previousBytes.get(owner) !== account.bytes)) {
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
    if (!pathname.startsWith('/api/') || pathname === '/api/live-logs' || pathname === '/api/bin-count') return;
    const binMatch = /^\/api\/bins\/([a-f0-9]{32})(?:\/query)?$/.exec(pathname);
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

  function lookupPath(value, pathValue) {
    if (typeof pathValue !== 'string' || !pathValue.trim()) fail(400, 'Lookup paths must be non-empty strings');
    const segments = pathValue.split('.');
    if (segments.some(segment => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment))) {
      fail(400, 'Lookup path contains an invalid property');
    }
    let current = value;
    for (const segment of segments) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
        return { found: false, value: undefined };
      }
      current = current[segment];
    }
    return { found: true, value: current };
  }

  function validateLookupWhere(where) {
    if (where === undefined) return;
    if (!where || typeof where !== 'object' || Array.isArray(where)) fail(400, 'Lookup where must be an object');
    const operators = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains']);
    for (const [pathValue, condition] of Object.entries(where)) {
      lookupPath({}, pathValue);
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        const names = Object.keys(condition);
        if (!names.length || names.some(name => !operators.has(name))) {
          fail(400, 'Lookup conditions support eq, ne, lt, lte, gt, gte, in, and contains');
        }
        if (Object.hasOwn(condition, 'in') && !Array.isArray(condition.in)) {
          fail(400, 'The in lookup condition requires an array');
        }
        if (Object.hasOwn(condition, 'contains') && typeof condition.contains !== 'string') {
          fail(400, 'The contains lookup condition requires a string');
        }
      }
    }
  }

  function lookupMatches(value, where = {}) {
    return Object.entries(where).every(([pathValue, condition]) => {
      const actual = lookupPath(value, pathValue);
      if (!actual.found) return false;
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
        return Object.is(actual.value, condition);
      }
      return Object.entries(condition).every(([operator, expected]) => {
        if (operator === 'eq') return Object.is(actual.value, expected);
        if (operator === 'ne') return !Object.is(actual.value, expected);
        if (operator === 'in') return expected.some(item => Object.is(actual.value, item));
        if (operator === 'contains') return typeof actual.value === 'string' && actual.value.includes(expected);
        if (typeof actual.value !== 'number' || typeof expected !== 'number') return false;
        if (operator === 'lt') return actual.value < expected;
        if (operator === 'lte') return actual.value <= expected;
        if (operator === 'gt') return actual.value > expected;
        if (operator === 'gte') return actual.value >= expected;
        return false;
      });
    });
  }

  function lookupBin(value, query) {
    if (!query || typeof query !== 'object' || Array.isArray(query) ||
        Object.keys(query).some(key => key !== 'steps') ||
        !Array.isArray(query.steps) || query.steps.length < 1 || query.steps.length > 12) {
      fail(400, 'Lookup body must contain 1 to 12 steps');
    }
    let results = [value];
    for (const step of query.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) ||
          Object.keys(step).some(key => !['array', 'where', 'select', 'level'].includes(key))) {
        fail(400, 'Each lookup step supports array, where, select, and level');
      }
      lookupPath({}, step.array);
      validateLookupWhere(step.where);
      if (step.select !== undefined) lookupPath({}, step.select);
      if (step.level !== undefined && (typeof step.level !== 'number' || !Number.isFinite(step.level))) {
        fail(400, 'Lookup level must be a finite number');
      }
      const next = [];
      for (const parent of results) {
        const collection = lookupPath(parent, step.array);
        if (!collection.found) continue;
        if (!Array.isArray(collection.value)) fail(400, `Lookup path ${step.array} must point to an array`);
        for (const item of collection.value) {
          if (!lookupMatches(item, step.where)) continue;
          if (step.level !== undefined) {
            const minLevel = lookupPath(item, 'MinLevel');
            const maxLevel = lookupPath(item, 'MaxLevel');
            if (!minLevel.found || !maxLevel.found ||
                typeof minLevel.value !== 'number' || typeof maxLevel.value !== 'number' ||
                step.level < minLevel.value || step.level > maxLevel.value) continue;
          }
          if (step.select === undefined) {
            next.push(item);
          } else {
            const selected = lookupPath(item, step.select);
            if (!selected.found) fail(400, `Selected path ${step.select} was not found`);
            const selectedKey = step.select.split('.').at(-1);
            next.push({ [selectedKey]: selected.value });
          }
          if (next.length > 1000) fail(413, 'Lookup result exceeds 1000 items');
        }
      }
      results = next;
    }
    const finalStep = query.steps[query.steps.length - 1];
    return finalStep.select !== undefined && results.length === 1 ? results[0] : results;
  }

  function size(value) {
    return Buffer.byteLength(JSON.stringify(value));
  }

  function secretKeyOwnerFor(req) {
    const key = req.headers['x-secret-key'];
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key.trim())) return null;
    return crypto.createHash('sha256').update(key.trim()).digest('hex');
  }

  function cookieOwnerFor(req) {
    const cookie = req.headers.cookie || '';
    const ownerCookie = /(?:^|;\s*)bin_owner=([a-f0-9]{64})(?:;|$)/.exec(cookie);
    return ownerCookie ? crypto.createHash('sha256').update(ownerCookie[1]).digest('hex') : null;
  }

  function accountFor(req) {
    const key = req.headers['x-secret-key'];
    return typeof key === 'string' && key.trim() ? secretKeyOwnerFor(req) : cookieOwnerFor(req);
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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/style.css' || url.pathname === '/icon.svg' || /^\/[a-z][a-z0-9-]*\.js$/.test(url.pathname))) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/css';
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', name)));
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        return send(req, res, 200, {
          donations: {
            patreon: process.env.PATREON_URL || '',
            buyMeACoffee: process.env.BUY_ME_A_COFFEE_URL || '',
            paypal: process.env.PAYPAL_DONATE_URL || ''
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/bin-count') {
        const count = fs.readdirSync(binsDir, { withFileTypes: true })
          .filter(entry => entry.isFile() && /^[a-f0-9]{32}\.json$/.test(entry.name)).length;
        return send(req, res, 200, { count });
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
          account = accounts[owner] = { bytes: 0, month: '', requests: 0, ephemeral: true };
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

      const lookupMatch = /^\/api\/bins\/([a-f0-9]{32})\/query$/.exec(url.pathname);
      if (lookupMatch) {
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        const bin = readBin(lookupMatch[1]);
        if (!bin) fail(404, 'Not found');
        req.binVisibility = bin.visibility;
        if (bin.visibility === 'private' && accountFor(req) !== bin.owner) {
          fail(401, 'Valid secret key required');
        }
        const result = lookupBin(bin.value, parse(await body(req)));
        const account = accounts[bin.owner];
        charge(account);
        bin.lastAccessedAt = Date.now();
        persistBin(lookupMatch[1], bin);
        persistAccounts();
        return send(req, res, 200, result);
      }

      const match = /^\/api\/bins\/([a-f0-9]{32})$/.exec(url.pathname);
      if (!match) fail(404, 'Not found');
      if (!['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) fail(405, 'Method not allowed');
      const bin = readBin(match[1]);
      if (!bin) fail(404, 'Not found');
      if (req.method === 'HEAD') {
        const authorized = bin.visibility !== 'private' || accountFor(req) === bin.owner;
        res.writeHead(authorized ? 204 : 401, {
          'Cache-Control': 'no-store',
          'X-Bin-Visibility': bin.visibility
        });
        res.end();
        return;
      }
      const requestedVisibility = req.method === 'PUT' && url.searchParams.has('visibility')
        ? url.searchParams.get('visibility')
        : null;
      if (requestedVisibility !== null && !['public', 'private'].includes(requestedVisibility)) {
        fail(400, 'Visibility must be public or private');
      }
      const visibility = requestedVisibility || bin.visibility;
      req.binVisibility = visibility;
      const owner = accountFor(req);
      const cookieOwner = cookieOwnerFor(req);
      const cookieAuthorizedVisibilityChange = requestedVisibility !== null && cookieOwner === bin.owner;
      if ((bin.visibility === 'private' || req.method !== 'GET') &&
          owner !== bin.owner && !cookieAuthorizedVisibilityChange) {
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
        account.bytes = Math.max(0, account.bytes - bin.bytes);
        removeBinFile(match[1]);
        if (cookieOwnerFor(req) === bin.owner && secretKeyOwnerFor(req) !== bin.owner && account.bytes === 0) {
          delete accounts[bin.owner];
        }
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
      const nextOwner = visibility === 'private' ? secretKeyOwnerFor(req) : bin.owner;
      const nextAccount = nextOwner && accounts[nextOwner];
      if (!nextAccount) fail(401, 'Valid secret key required');
      const ownershipChanged = nextOwner !== bin.owner;
      const bytes = checkSize(value, nextAccount, ownershipChanged ? 0 : bin.bytes);
      charge(nextAccount);
      if (ownershipChanged) {
        account.bytes = Math.max(0, account.bytes - bin.bytes);
        if (cookieAuthorizedVisibilityChange && account.bytes === 0) delete accounts[bin.owner];
        nextAccount.bytes += bytes;
        bin.owner = nextOwner;
      } else {
        nextAccount.bytes += bytes - bin.bytes;
      }
      bin.visibility = visibility;
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
