const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function page({ dark = false, stored = null, storageBlocked = false, sessionStored = null, sessionStorageBlocked = false } = {}) {
  const elements = new Map();
  let beforeUnload;
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      if (!elements.has(id)) {
        const attributes = {};
        elements.set(id, {
          value: '',
          listeners: {},
          addEventListener(event, callback) { this.listeners[event] = callback; },
          setAttribute(name, value) { attributes[name] = value; },
          getAttribute(name) { return attributes[name]; }
        });
      }
      return elements.get(id);
    }
  };
  const system = {
    matches: dark,
    addEventListener(event, callback) { this.onChange = callback; }
  };
  const localStorage = {
    getItem() { if (storageBlocked) throw new Error('blocked'); return stored; },
    setItem(name, value) { if (storageBlocked) throw new Error('blocked'); stored = value; }
  };
  const sessionValues = new Map(sessionStored === null ? [] : [['jsonstorage.editorDraft', sessionStored]]);
  const sessionStorage = {
    getItem(name) { if (sessionStorageBlocked) throw new Error('blocked'); return sessionValues.get(name) || null; },
    setItem(name, value) { if (sessionStorageBlocked) throw new Error('blocked'); sessionValues.set(name, value); }
  };
  const window = {
    matchMedia: () => system,
    addEventListener(event, callback) { if (event === 'beforeunload') beforeUnload = callback; }
  };
  vm.runInNewContext(script, { document, window, localStorage, sessionStorage });
  return {
    document, system, toggle: elements.get('theme-toggle'), editor: elements.get('editor'),
    beforeUnload, sessionStorage, stored: () => stored
  };
}

test('follows system theme until the user chooses a theme', () => {
  const { document, system, toggle, stored } = page();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  system.matches = true;
  system.onChange();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  toggle.listeners.click();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(stored(), 'light');
  system.matches = false;
  system.onChange();
  system.matches = true;
  system.onChange();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});

test('restores a saved theme and works when storage is unavailable', () => {
  const restored = page({ stored: 'dark' });
  assert.equal(restored.document.documentElement.dataset.theme, 'dark');
  assert.equal(restored.toggle.getAttribute('aria-pressed'), 'true');
  const blocked = page({ storageBlocked: true });
  blocked.toggle.listeners.click();
  assert.equal(blocked.document.documentElement.dataset.theme, 'dark');
  assert.equal(blocked.toggle.getAttribute('aria-pressed'), 'true');
});

test('warns before leaving with unsaved editor content', () => {
  const { editor, beforeUnload } = page();
  editor.value = '{"unsaved":true}';
  let prevented = false;
  const event = { preventDefault() { prevented = true; }, returnValue: undefined };
  beforeUnload(event);
  assert.equal(prevented, true);
  assert.notEqual(event.returnValue, undefined);
});

test('stores an editor draft for refresh and restores it in the same tab', () => {
  const firstPage = page();
  firstPage.editor.value = '{"draft":true}';
  firstPage.editor.listeners.input();
  const savedDraft = firstPage.sessionStorage.getItem('jsonstorage.editorDraft');
  assert.deepEqual(JSON.parse(savedDraft), { value: '{"draft":true}', saved: false });
  const refreshedPage = page({ sessionStored: savedDraft });
  assert.equal(refreshedPage.editor.value, '{"draft":true}');
  assert.match(refreshedPage.document.getElementById('draft-state').textContent, /restored/i);
});
