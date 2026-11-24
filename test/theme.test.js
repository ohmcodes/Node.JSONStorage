const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function page({ dark = false, stored = null, storageBlocked = false } = {}) {
  const elements = new Map();
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      if (!elements.has(id)) {
        const attributes = {};
        elements.set(id, {
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
  vm.runInNewContext(script, { document, window: { matchMedia: () => system }, localStorage });
  return { document, system, toggle: elements.get('theme-toggle'), stored: () => stored };
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
