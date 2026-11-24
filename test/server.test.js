const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  return { request, key: account.body.secretKey, dir };
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
  assert.equal((await request(url)).status, 401);
  assert.deepEqual((await request(url, options('GET', key))).body, { a: 1 });
  assert.equal((await request(url, options('PUT', '0'.repeat(64), {}))).status, 401);
  assert.deepEqual((await request(url, options('PATCH', key, { b: 2 }))).body, { a: 1, b: 2 });
  assert.deepEqual((await request(url, options('PUT', key, [1, 2]))).body, [1, 2]);
  assert.equal((await request(url, options('PATCH', key, {}))).status, 400);
  assert.equal((await request(url, options('DELETE', key))).status, 200);
  assert.equal((await request(url, options('GET', key))).status, 404);
  const publicBin = await request('/api/bins', options('POST', key, null));
  assert.equal((await request(`/api/bins/${publicBin.body.id}`)).body, null);
  assert.equal(fs.readFileSync(path.join(dir, 'storage.json'), 'utf8').includes(key), false);
});

test('validates input, size limits and repairs JSON', async t => {
  const { request, key } = await setup(t);
  assert.equal((await request('/api/bins', options('POST', null, {}))).status, 401);
  assert.equal((await request('/api/bins?visibility=other', options('POST', key, {}))).status, 400);
  assert.equal((await request('/api/bins', { method: 'POST', headers: { 'x-secret-key': key }, body: '{' })).status, 400);
  assert.equal((await request('/api/bins', options('POST', key, 'x'.repeat(100 * 1024)))).status, 413);
  const repaired = await request('/api/repair', { method: 'POST', body: "{foo: 'bar',}" });
  assert.deepEqual(JSON.parse(repaired.body.json), { foo: 'bar' });
  assert.equal((await request('/api/repair', { method: 'POST', body: '' })).status, 400);
});

test('persists bins and enforces the monthly request limit', async t => {
  const { request, key, dir } = await setup(t);
  const bin = await request('/api/bins', options('POST', key, { saved: true }));
  const file = path.join(dir, 'storage.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const account = Object.values(db.accounts)[0];
  account.month = new Date().toISOString().slice(0, 7);
  account.requests = 10000;
  fs.writeFileSync(file, JSON.stringify(db));
  const restarted = createServer({ dataDir: dir });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${restarted.address().port}/api/bins/${bin.body.id}`);
  assert.equal(response.status, 429);
});
