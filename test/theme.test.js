const { test } = require('node:test');
const assert = require('node:assert/strict');

async function themeModule() {
  return import('../public/theme.js');
}

async function draftModule() {
  return import('../public/draft.js');
}

async function binSyncModule() {
  return import('../public/bin-sync.js');
}

function themePage({ stored = null, storageBlocked = false } = {}) {
  const select = {
    value: '',
    addEventListener(event, callback) { this.onChange = callback; }
  };
  const document = { documentElement: { dataset: {} }, getElementById: () => select };
  const values = new Map(stored === null ? [] : [['theme', stored]]);
  const storage = {
    getItem(name) { if (storageBlocked) throw new Error('blocked'); return values.get(name) || null; },
    setItem(name, value) { if (storageBlocked) throw new Error('blocked'); values.set(name, value); }
  };
  return { document, select, storage };
}

test('defaults to dark and persists both theme selections', async () => {
  const { initializeTheme } = await themeModule();
  const page = themePage();
  initializeTheme(page);
  assert.equal(page.document.documentElement.dataset.theme, 'dark');
  assert.equal(page.select.value, 'dark');
  page.select.value = 'light';
  page.select.onChange();
  assert.equal(page.document.documentElement.dataset.theme, 'light');
  assert.equal(page.storage.getItem('theme'), 'light');
  page.select.value = 'dark';
  page.select.onChange();
  assert.equal(page.document.documentElement.dataset.theme, 'dark');
  assert.equal(page.storage.getItem('theme'), 'dark');
});

test('restores a saved theme and tolerates blocked storage', async () => {
  const { initializeTheme } = await themeModule();
  const restored = themePage({ stored: 'light' });
  initializeTheme(restored);
  assert.equal(restored.document.documentElement.dataset.theme, 'light');
  assert.equal(restored.select.value, 'light');
  const invalid = themePage({ stored: 'invalid' });
  initializeTheme(invalid);
  assert.equal(invalid.select.value, 'dark');
  const blocked = themePage({ storageBlocked: true });
  initializeTheme(blocked);
  blocked.select.value = 'light';
  blocked.select.onChange();
  assert.equal(blocked.document.documentElement.dataset.theme, 'light');
});

test('stores and restores a draft in the same tab', async () => {
  const { createDraftController } = await draftModule();
  const values = new Map();
  const sessionStorage = {
    getItem(name) { return values.get(name) || null; },
    setItem(name, value) { values.set(name, value); }
  };
  const editor = { value: '' };
  const draftState = { textContent: '' };
  const first = createDraftController({ sessionStorage, editor, draftState });
  editor.value = '{"draft":true}';
  first.store();
  assert.deepEqual(JSON.parse(values.get('jsonstorage.editorDraft')), { value: '{"draft":true}', saved: false });

  const restoredEditor = { value: '' };
  const restored = createDraftController({ sessionStorage, editor: restoredEditor, draftState });
  assert.equal(restoredEditor.value, '{"draft":true}');
  assert.match(draftState.textContent, /restored/i);
  assert.equal(restored.hasUnsavedEditorContent(), true);
});

test('reconciles missing saved bins and server-side visibility', async () => {
  const { reconcileEntries } = await binSyncModule();
  const missingId = 'a'.repeat(32);
  const changedId = 'b'.repeat(32);
  const entries = [
    { id: missingId, visibility: 'public' },
    { id: changedId, visibility: 'public' }
  ];
  const result = await reconcileEntries(entries, async entry => {
    if (entry.id === missingId) return { missing: true };
    return { visibility: 'private' };
  });
  assert.deepEqual(result, {
    entries: [{ id: changedId, visibility: 'private' }],
    missingCount: 1
  });
});
