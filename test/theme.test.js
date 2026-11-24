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

function themePage({ dark = false, stored = null, storageBlocked = false } = {}) {
  let onSystemChange;
  const attributes = {};
  const toggle = {
    addEventListener(event, callback) { this.onClick = callback; },
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name]; }
  };
  const document = { documentElement: { dataset: {} }, getElementById: () => toggle };
  const systemTheme = {
    matches: dark,
    addEventListener(event, callback) { onSystemChange = callback; }
  };
  const values = new Map(stored === null ? [] : [['theme', stored]]);
  const storage = {
    getItem(name) { if (storageBlocked) throw new Error('blocked'); return values.get(name) || null; },
    setItem(name, value) { if (storageBlocked) throw new Error('blocked'); values.set(name, value); }
  };
  const window = { matchMedia: () => systemTheme };
  return { document, toggle, systemTheme, storage, window, attributes, onSystemChange: () => onSystemChange };
}

test('follows system theme until the user chooses a theme', async () => {
  const { initializeTheme } = await themeModule();
  const page = themePage();
  initializeTheme(page);
  assert.equal(page.attributes['aria-pressed'], 'false');
  page.systemTheme.matches = true;
  page.onSystemChange()();
  assert.equal(page.attributes['aria-pressed'], 'true');
  page.toggle.onClick();
  assert.equal(page.document.documentElement.dataset.theme, 'light');
  assert.equal(page.storage.getItem('theme'), 'light');
});

test('restores a saved theme and tolerates blocked storage', async () => {
  const { initializeTheme } = await themeModule();
  const restored = themePage({ stored: 'dark' });
  initializeTheme(restored);
  assert.equal(restored.document.documentElement.dataset.theme, 'dark');
  assert.equal(restored.attributes['aria-pressed'], 'true');
  const blocked = themePage({ storageBlocked: true });
  initializeTheme(blocked);
  blocked.toggle.onClick();
  assert.equal(blocked.document.documentElement.dataset.theme, 'dark');
  assert.equal(blocked.attributes['aria-pressed'], 'true');
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
