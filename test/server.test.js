const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../server');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-'));
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => {
    const response = await fetch(base + url, options);
    return { status: response.status, body: await response.json() };
  };
  const account = await request('/api/accounts', { method: 'POST' });
  return { request, key: account.body.secretKey, dir, base };
}

function options(method, key, value) {
  return {
    method,
    headers: key ? { 'x-secret-key': key } : {},
    ...(value === undefined ? {} : { body: JSON.stringify(value) })
  };
}

test('public and private bins enforce ownership and support CRUD', async t => {
  const { request, key, dir } = await setup(t);
  const created = await request('/api/bins?visibility=private', options('POST', key, { a: 1 }));
  assert.equal(created.status, 201);
  const url = `/api/bins/${created.body.id}`;
  const privateBinFile = path.join(dir, 'bins', `${created.body.id}.json`);
  assert.equal(fs.existsSync(privateBinFile), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(privateBinFile, 'utf8')).value, { a: 1 });
  assert.equal((await request(url)).status, 401);
  assert.deepEqual((await request(url, options('GET', key))).body, { a: 1 });
  assert.equal((await request(url, options('PUT', '0'.repeat(64), {}))).status, 401);
  assert.deepEqual((await request(url, options('PATCH', key, { b: 2 }))).body, { a: 1, b: 2 });
  assert.deepEqual((await request(url, options('PUT', key, [1, 2]))).body, [1, 2]);
  assert.equal((await request(url, options('PATCH', key, {}))).status, 400);
  assert.equal((await request(url, options('DELETE', key))).status, 200);
  assert.equal(fs.existsSync(privateBinFile), false);
  assert.equal((await request(url, options('GET', key))).status, 404);
  const publicBin = await request('/api/bins', options('POST', key, null));
  const publicUrl = `/api/bins/${publicBin.body.id}`;
  assert.equal((await request(publicUrl)).body, null);
  assert.equal((await request(publicUrl, options('DELETE', null))).status, 401);
  assert.equal((await request(publicUrl, options('DELETE', '0'.repeat(64)))).status, 401);
  assert.equal((await request(publicUrl, options('DELETE', key))).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'bins', `${publicBin.body.id}.json`)), false);
  const accountsAfterDelete = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
  const owner = crypto.createHash('sha256').update(key).digest('hex');
  assert.equal(accountsAfterDelete[owner].bytes, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8').includes(key), false);
  assert.equal(fs.existsSync(path.join(dir, 'storage.json')), false);
});

test('HEAD checks saved-bin state without reading or extending bin usage', async t => {
  const { request, key, dir, base } = await setup(t);
  const created = await request('/api/bins?visibility=public', options('POST', key, { available: true }));
  const url = `${base}/api/bins/${created.body.id}`;
  const file = path.join(dir, 'bins', `${created.body.id}.json`);
  const beforeBin = JSON.parse(fs.readFileSync(file, 'utf8'));
  const beforeAccount = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'))[
    crypto.createHash('sha256').update(key).digest('hex')
  ];

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 204);
  assert.equal(head.headers.get('x-bin-visibility'), 'public');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), beforeBin);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'))[
      crypto.createHash('sha256').update(key).digest('hex')
    ],
    beforeAccount
  );

  const missing = await fetch(`${base}/api/bins/${'0'.repeat(32)}`, { method: 'HEAD' });
  assert.equal(missing.status, 404);

  const privateBin = await request('/api/bins?visibility=private', options('POST', key, { private: true }));
  const privateHead = await fetch(`${base}/api/bins/${privateBin.body.id}`, { method: 'HEAD' });
  assert.equal(privateHead.status, 401);
  assert.equal(privateHead.headers.get('x-bin-visibility'), 'private');
});

test('public app config returns only donation URL settings', async t => {
  const { request } = await setup(t);
  const response = await request('/api/config');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['donations']);
  assert.deepEqual(Object.keys(response.body.donations).sort(), ['buyMeACoffee', 'patreon', 'paypal']);
  assert.ok(Object.values(response.body.donations).every(value => typeof value === 'string'));
});

test('serves browser ES modules as JavaScript', async t => {
  const { base } = await setup(t);
  const modules = ['app.js', 'core.js', 'api.js', 'bins.js', 'bin-sync.js', 'live-logs.js', 'actions.js', 'events.js', 'donations.js', 'theme.js', 'draft.js'];
  for (const moduleName of modules) {
    const response = await fetch(`${base}/${moduleName}`);
    assert.equal(response.status, 200, moduleName);
    assert.match(response.headers.get('content-type'), /text\/javascript/, moduleName);
  }
  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /<script type="module" src="\/app\.js"><\/script>/);
});

test('validates input, size limits and repairs JSON', async t => {
  const { request, key } = await setup(t);
  assert.equal((await request('/api/bins?visibility=private', options('POST', null, {}))).status, 401);
  assert.equal((await request('/api/bins?visibility=other', options('POST', key, {}))).status, 400);
  assert.equal((await request('/api/bins', { method: 'POST', headers: { 'x-secret-key': key }, body: '{' })).status, 400);
  assert.equal((await request('/api/bins', options('POST', key, 'x'.repeat(100 * 1024)))).status, 413);
  const repaired = await request('/api/repair', { method: 'POST', body: "{foo: 'bar',}" });
  assert.deepEqual(JSON.parse(repaired.body.json), { foo: 'bar' });
  assert.equal((await request('/api/repair', { method: 'POST', body: '' })).status, 400);
});

test('keyless Public bins use an HttpOnly owner cookie for mutations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-public-cookie-'));
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${base}/api/bins?visibility=public`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public: true })
  });
  assert.equal(createdResponse.status, 201);
  const cookie = createdResponse.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const cookieHeader = cookie.split(';')[0];
  const cookieOwnerHash = crypto.createHash('sha256').update(cookieHeader.split('=')[1]).digest('hex');
  const { id } = await createdResponse.json();
  const url = `${base}/api/bins/${id}`;

  assert.deepEqual(await (await fetch(url)).json(), { public: true });
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(url, {
    method: 'PUT',
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ edited: true })
  })).status, 200);

  const accountResponse = await fetch(`${base}/api/accounts`, { method: 'POST' });
  const { secretKey } = await accountResponse.json();
  const privateValue = { private: true };
  assert.equal((await fetch(`${url}?visibility=private`, {
    method: 'PUT',
    headers: { 'x-secret-key': secretKey, 'content-type': 'application/json' },
    body: JSON.stringify(privateValue)
  })).status, 401);
  assert.equal((await fetch(`${url}?visibility=private`, {
    method: 'PUT',
    headers: {
      cookie: cookieHeader,
      'x-secret-key': secretKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(privateValue)
  })).status, 200);
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await (await fetch(url, { headers: { 'x-secret-key': secretKey } })).json(), privateValue);

  const binFile = path.join(dir, 'bins', `${id}.json`);
  const privateBin = JSON.parse(fs.readFileSync(binFile, 'utf8'));
  assert.equal(privateBin.visibility, 'private');
  assert.equal(privateBin.owner, crypto.createHash('sha256').update(secretKey).digest('hex'));
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
  assert.equal(Object.hasOwn(accounts, cookieOwnerHash), false);
  assert.equal(accounts[privateBin.owner].bytes, Buffer.byteLength(JSON.stringify(privateValue)));

  const publicValue = { public: true };
  assert.equal((await fetch(`${url}?visibility=public`, {
    method: 'PUT',
    headers: { 'x-secret-key': secretKey, 'content-type': 'application/json' },
    body: JSON.stringify(publicValue)
  })).status, 200);
  assert.deepEqual(await (await fetch(url)).json(), publicValue);
  assert.equal(JSON.parse(fs.readFileSync(binFile, 'utf8')).visibility, 'public');
  assert.equal((await fetch(url, { method: 'DELETE', headers: { 'x-secret-key': secretKey } })).status, 200);
});

test('deleting the last cookie-owned bin removes its orphan account record', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-orphan-cookie-'));
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/bins?visibility=public`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ temporary: true })
  });
  const cookie = created.headers.get('set-cookie').split(';')[0];
  const cookieOwner = crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  const { id } = await created.json();

  assert.equal((await fetch(`${base}/api/bins/${id}`, {
    method: 'DELETE',
    headers: { cookie }
  })).status, 200);
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
  assert.equal(Object.hasOwn(accounts, cookieOwner), false);
});

test('persists bins and enforces the monthly request limit', async t => {
  const { request, key, dir } = await setup(t);
  const bin = await request('/api/bins', options('POST', key, { saved: true }));
  const file = path.join(dir, 'accounts.json');
  const accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const account = Object.values(accounts)[0];
  account.month = new Date().toISOString().slice(0, 7);
  account.requests = 10000;
  fs.writeFileSync(file, JSON.stringify(accounts));
  assert.equal(fs.existsSync(path.join(dir, 'bins', `${bin.body.id}.json`)), true);
  const restarted = createServer({ dataDir: dir });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${restarted.address().port}/api/bins/${bin.body.id}`);
  assert.equal(response.status, 429);
});

test('enforces account quota and frees space on delete', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-quota-'));
  const key = crypto.randomBytes(32).toString('hex');
  const owner = crypto.createHash('sha256').update(key).digest('hex');
  const db = { accounts: { [owner]: { bytes: 10 * 1024 * 1024, month: '', requests: 0 } }, bins: {} };
  for (let i = 0; i < 103; i++) {
    const bytes = i === 102 ? 40 * 1024 : 100 * 1024;
    db.bins[i.toString(16).padStart(32, '0')] = { owner, visibility: 'private', value: 'x'.repeat(bytes - 2), bytes };
  }
  fs.mkdirSync(path.join(dir, 'bins'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(db.accounts));
  for (const [id, bin] of Object.entries(db.bins)) {
    fs.writeFileSync(path.join(dir, 'bins', `${id}.json`), JSON.stringify(bin));
  }
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/bins`, options('POST', key, 1))).status, 413);
  assert.equal((await fetch(`${base}/api/bins/${'0'.repeat(32)}`, options('DELETE', key))).status, 200);
  assert.equal((await fetch(`${base}/api/bins`, options('POST', key, 'x'.repeat(100 * 1024 - 2)))).status, 201);
});

test('migrates legacy storage.json into account and per-bin files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-migration-'));
  const key = crypto.randomBytes(32).toString('hex');
  const owner = crypto.createHash('sha256').update(key).digest('hex');
  const id = 'a'.repeat(32);
  const legacy = {
    accounts: { [owner]: { bytes: 16, month: '', requests: 0 } },
    bins: { [id]: { owner, visibility: 'private', value: { migrated: true }, bytes: 16 } }
  };
  fs.writeFileSync(path.join(dir, 'storage.json'), JSON.stringify(legacy));
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/bins/${id}`, { headers: { 'x-secret-key': key } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { migrated: true });
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'bins', `${id}.json`)), true);
  assert.equal(fs.existsSync(path.join(dir, 'storage.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'storage.json.migrated')), true);
});

test('rebuilds account quota after a bin file is manually removed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-manual-delete-'));
  const key = crypto.randomBytes(32).toString('hex');
  const owner = crypto.createHash('sha256').update(key).digest('hex');
  const id = 'b'.repeat(32);
  const binsDir = path.join(dir, 'bins');
  fs.mkdirSync(binsDir);
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    [owner]: { bytes: 42, month: '', requests: 0, ephemeral: true }
  }));
  fs.writeFileSync(path.join(binsDir, `${id}.json`), JSON.stringify({
    owner, visibility: 'public', value: 'x'.repeat(40), bytes: 42
  }));

  fs.rmSync(path.join(binsDir, `${id}.json`));
  const server = createServer({ dataDir: dir });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')), owner), false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bins?visibility=public`, options('POST', null, { available: true }));
  assert.equal(response.status, 201);
});

test('expires inactive bins and refreshes inactivity on successful GET', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-expiry-'));
  const server = createServer({ dataDir: dir, binInactivityMs: 500, binCleanupIntervalMs: 10 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const accountResponse = await fetch(`${base}/api/accounts`, { method: 'POST' });
  const { secretKey } = await accountResponse.json();
  const createResponse = await fetch(`${base}/api/bins?visibility=public`, options('POST', secretKey, { active: true }));
  const { id } = await createResponse.json();
  const binFile = path.join(dir, 'bins', `${id}.json`);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await fetch(`${base}/api/bins/${id}`)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await fetch(`${base}/api/bins/${id}`)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal((await fetch(`${base}/api/bins/${id}`)).status, 404);
  assert.equal(fs.existsSync(binFile), false);
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
  assert.equal(accounts[Object.keys(accounts)[0]].bytes, 0);
});

test('streams public-safe activity and redacts private bin IDs and secret keys', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-logs-'));
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const base = `http://127.0.0.1:${server.address().port}`;

  const stream = await fetch(`${base}/api/live-logs`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();

  const accountResponse = await fetch(`${base}/api/accounts`, { method: 'POST' });
  const { secretKey } = await accountResponse.json();
  const createdResponse = await fetch(`${base}/api/bins?visibility=private`, {
    method: 'POST',
    headers: { 'x-secret-key': secretKey, 'content-type': 'application/json' },
    body: JSON.stringify({ private: 'payload-not-logged' })
  });
  const created = await createdResponse.json();
  const publicResponse = await fetch(`${base}/api/bins?visibility=public`, {
    method: 'POST',
    headers: { 'x-secret-key': secretKey, 'content-type': 'application/json' },
    body: JSON.stringify({ public: 'also-not-logged' })
  });
  const publicBin = await publicResponse.json();

  let logText = '';
  const decoder = new TextDecoder();
  while (!logText.includes(publicBin.id)) {
    const { done, value } = await reader.read();
    assert.equal(done, false);
    logText += decoder.decode(value, { stream: true });
  }
  const events = [...logText.matchAll(/^data: (\{.*\})$/gm)].map(match => JSON.parse(match[1]));
  const privateEvent = events.find(event => event.endpoint === '/api/bins' && event.method === 'POST' && event.binId === null);
  const publicEvent = events.find(event => event.binId === publicBin.id);
  assert.ok(privateEvent);
  assert.ok(publicEvent);
  assert.equal(publicEvent.method, 'POST');
  assert.equal(publicEvent.status, 201);
  assert.equal(Object.hasOwn(publicEvent, 'account'), false);
  assert.equal(logText.includes(created.id), false);
  assert.equal(logText.includes(secretKey), false);
  assert.equal(logText.includes('payload-not-logged'), false);
  assert.equal(logText.includes('also-not-logged'), false);
  await reader.cancel();
});

test('ends public live-log streams after inactivity or the session limit', async t => {
  async function readStoppedStream(name, options) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `json-storage-${name}-`));
    const server = createServer({ dataDir: dir, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    })));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/live-logs`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  const idleText = await readStoppedStream('idle-log', { liveLogIdleMs: 60, liveLogSessionMs: 500 });
  assert.match(idleText, /"reason":"inactive"/);
  const limitedText = await readStoppedStream('limited-log', { liveLogIdleMs: 500, liveLogSessionMs: 60 });
  assert.match(limitedText, /"reason":"session-limit"/);
});
