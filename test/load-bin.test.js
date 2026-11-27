const { test } = require('node:test');
const assert = require('node:assert/strict');

test('load by ID checks visibility, authenticates private bins and preserves editor on failure', async t => {
  const previous = {};
  for (const name of ['document', 'localStorage', 'sessionStorage', 'fetch', 'confirm']) previous[name] = global[name];
  t.after(() => Object.assign(global, previous));
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', dataset: {}, hidden: false,
      setAttribute() {}, replaceChildren() {}, append() {}, focus() {}, scrollIntoView() {},
      dispatchEvent() {}, addEventListener() {}
    });

    return elements.get(id);
  }
  const radios = { public: element('radio-public'), private: element('radio-private') };
  global.document = {
    getElementById: element,
    querySelector(selector) { return selector.includes('"private"') ? radios.private : radios.public; },
    createElement() { return { dataset: {}, append() {} }; }
  };
  const values = new Map();
  global.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  global.sessionStorage = { getItem: () => null, setItem() {} };
  global.confirm = () => true;
  const publicId = 'a'.repeat(32);
  const privateId = 'b'.repeat(32);
  const missingId = 'c'.repeat(32);
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith(missingId)) return new Response(null, { status: 404 });
    const isPrivate = url.endsWith(privateId);
    if (options.method === 'HEAD') return new Response(null, {
      status: isPrivate ? 401 : 204,
      headers: { 'X-Bin-Visibility': isPrivate ? 'private' : 'public' }
    });
    if (isPrivate && options.headers['X-Secret-Key'] !== 'owner-key') {
      return Response.json({ error: 'Valid secret key required' }, { status: 401 });
    }
    return Response.json({ visibility: isPrivate ? 'private' : 'public' });
  };
  const { loadBinById, getSavedBins, rememberSavedBin, reconcileSavedBins } = await import('../public/bins.js');
  const { state } = await import('../public/core.js');
  const id = element('load-bin-id');
  const editor = element('editor');
  id.value = 'invalid';
  await assert.rejects(loadBinById(), /valid 32-character/);
  assert.equal(calls.length, 0);
  id.value = missingId;
  await assert.rejects(loadBinById(), /not found/);
  assert.equal(getSavedBins().length, 0);
  id.value = publicId;
  element('key').value = 'unrelated-key';
  await loadBinById();
  assert.equal(calls.at(-1).options.headers['X-Secret-Key'], '');
  assert.deepEqual(JSON.parse(editor.value), { visibility: 'public' });
  assert.equal(state.currentSavedBinId, publicId);
  assert.equal(getSavedBins()[0].id, publicId);
  id.value = privateId;
  element('key').value = '';
  await assert.rejects(loadBinById(), /owner key/);
  assert.equal(state.currentSavedBinId, publicId);
  assert.equal(radios.public.checked, true);
  assert.notEqual(radios.private.checked, true);
  element('key').value = 'wrong-key';
  await assert.rejects(loadBinById(), /valid owner key/);
  assert.equal(state.currentSavedBinId, publicId);
  assert.deepEqual(JSON.parse(editor.value), { visibility: 'public' });
  assert.equal(getSavedBins().length, 1);
  assert.notEqual(radios.private.checked, true);
  element('key').value = 'owner-key';
  await loadBinById();
  assert.deepEqual(JSON.parse(editor.value), { visibility: 'private' });
  assert.equal(state.currentSavedBinId, privateId);
  assert.equal(getSavedBins()[0].id, privateId);
  editor.value = 'unsaved changes';
  global.confirm = () => false;
  id.value = publicId;
  await loadBinById();
  assert.equal(editor.value, 'unsaved changes');
  assert.equal(state.currentSavedBinId, privateId);
  const pendingChecks = [];
  global.fetch = () => new Promise(resolve => pendingChecks.push(resolve));
  const reconciliation = reconcileSavedBins();
  const newId = 'd'.repeat(32);
  rememberSavedBin(newId, 'public');
  for (const resolve of pendingChecks) resolve(new Response(null, { status: 404 }));
  await reconciliation;
  assert.equal(getSavedBins().length, 3);
  assert.equal(getSavedBins()[0].id, newId);
});

test('bin count reports errors and ignores stale responses', async t => {
  const previous = { document: global.document, fetch: global.fetch };
  t.after(() => Object.assign(global, previous));
  const output = { textContent: '' };
  global.document = { getElementById: () => output };
  const pending = [];
  global.fetch = () => new Promise(resolve => pending.push(resolve));
  const { refreshBinCount } = await import('../public/bin-count.js');
  const older = refreshBinCount();
  const newer = refreshBinCount();
  pending[1](Response.json({ count: 2 }));
  await newer;
  pending[0](Response.json({ count: 1 }));
  await older;
  assert.equal(output.textContent, 'Current bins on server: 2');
  global.fetch = async () => Response.json({ count: -1 });
  await refreshBinCount();
  assert.equal(output.textContent, 'Current bins on server: unavailable');
  global.fetch = async () => { throw new Error('offline'); };
  await refreshBinCount();
  assert.equal(output.textContent, 'Current bins on server: unavailable');
});
