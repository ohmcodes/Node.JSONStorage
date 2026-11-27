const { test } = require('node:test');
const assert = require('node:assert/strict');

test('existing private bins require a key but not copying it again', async t => {
  const previous = {};
  for (const name of ['document', 'window', 'localStorage', 'sessionStorage', 'fetch', 'confirm']) previous[name] = global[name];
  t.after(() => Object.assign(global, previous));
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', dataset: {}, hidden: true,
      setAttribute() {}, replaceChildren() {}, append() {}, addEventListener() {}, focus() {}
    });
    return elements.get(id);
  }
  global.document = {
    getElementById: element,
    querySelector: () => ({ value: 'private' }),
    createElement: () => ({ dataset: {}, append() {} })
  };
  global.window = { location: { origin: 'http://localhost' } };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = { getItem: () => null, setItem() {} };
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/accounts') return Response.json({ secretKey: 'generated-key' });
    if (options.headers['X-Secret-Key'] === 'wrong-key') {
      return Response.json({ error: 'Valid secret key required' }, { status: 401 });
    }
    return Response.json({ id: 'a'.repeat(32), visibility: 'private' });
  };
  const { state } = await import('../public/core.js');
  const { saveBin, clearJson } = await import('../public/actions.js');
  element('editor').value = '{"value":1}';
  state.currentSavedBinId = 'a'.repeat(32);
  await assert.rejects(saveBin(), /require the owner key/);
  assert.equal(calls.length, 0);
  element('key').value = 'wrong-key';
  await assert.rejects(saveBin(), /Valid secret key required/);
  element('key').value = 'owner-key';
  await saveBin();
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.equal(calls.at(-1).options.headers['X-Secret-Key'], 'owner-key');
  assert.equal(element('key-error').hidden, true);

  state.currentSavedBinId = '';
  element('key').value = '';
  await assert.rejects(saveBin(), /Copy the owner key/);
  assert.equal(calls.at(-1).url, '/api/accounts');
  assert.equal(element('key').value, 'generated-key');
  await assert.rejects(saveBin(), /Copy the owner key/);
  state.copiedKeyValue = 'generated-key';
  await saveBin();
  assert.ok(calls.some(call => call.url === '/api/bins?visibility=private' && call.options.method === 'POST'));

  global.confirm = () => false;
  clearJson();
  assert.notEqual(element('editor').value, '');
  global.confirm = () => true;
  clearJson();
  assert.equal(element('editor').value, '');
  assert.equal(state.currentSavedBinId, 'a'.repeat(32));
  assert.equal(element('status').textContent, 'Editor cleared');
});
