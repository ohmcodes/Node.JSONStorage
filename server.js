const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { jsonrepair } = require('jsonrepair');

const BIN_LIMIT = 100 * 1024;
const ACCOUNT_LIMIT = 10 * 1024 * 1024;
const REQUEST_LIMIT = 10000;
const BODY_LIMIT = 1024 * 1024;

function createServer({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data') } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'storage.json');
  const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { accounts: {}, bins: {} };

  function persist() {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function send(res, status, value) {
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
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return null;
    return crypto.createHash('sha256').update(key).digest('hex');
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

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css';
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', name)));
      }

      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const key = crypto.randomBytes(32).toString('hex');
        const owner = crypto.createHash('sha256').update(key).digest('hex');
        db.accounts[owner] = { bytes: 0, month: '', requests: 0 };
        persist();
        return send(res, 201, { secretKey: key });
      }

      if (req.method === 'POST' && url.pathname === '/api/repair') {
        const text = await body(req);
        try {
          return send(res, 200, { json: JSON.stringify(JSON.parse(jsonrepair(text)), null, 2) });
        } catch {
          return send(res, 400, { error: 'Unable to repair JSON' });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/bins') {
        const owner = accountFor(req);
        const account = db.accounts[owner];
        if (!account) fail(401, 'Valid secret key required');
        const visibility = url.searchParams.get('visibility') || 'public';
        if (!['public', 'private'].includes(visibility)) fail(400, 'Visibility must be public or private');
        const value = parse(await body(req));
        const bytes = checkSize(value, account);
        charge(account);
        const id = crypto.randomBytes(16).toString('hex');
        db.bins[id] = { owner, visibility, value, bytes };
        account.bytes += bytes;
        persist();
        return send(res, 201, { id, visibility });
      }

      const match = /^\/api\/bins\/([a-f0-9]{32})$/.exec(url.pathname);
      if (!match) fail(404, 'Not found');
      if (!['GET', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) fail(405, 'Method not allowed');
      const bin = db.bins[match[1]];
      if (!bin) fail(404, 'Not found');
      const owner = accountFor(req);
      if ((bin.visibility === 'private' || req.method !== 'GET') && owner !== bin.owner) {
        fail(401, 'Valid secret key required');
      }
      const account = db.accounts[bin.owner];
      if (req.method === 'GET') {
        charge(account);
        persist();
        return send(res, 200, bin.value);
      }
      if (req.method === 'DELETE') {
        charge(account);
        account.bytes -= bin.bytes;
        delete db.bins[match[1]];
        persist();
        return send(res, 200, { deleted: true });
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
      persist();
      return send(res, 200, bin.value);
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
      else res.destroy();
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`JSON Storage listening on http://${host}:${port}`));
}

module.exports = { createServer };
