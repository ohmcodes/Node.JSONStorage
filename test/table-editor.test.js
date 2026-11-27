const { test } = require('node:test');
const assert = require('node:assert/strict');

class Element {
  constructor(tag = '') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  emit(name, event = {}) { this.listeners[name]({ target: this, ...event }); }
  matches(selector) {
    return selector.split(', ').some(part => part.startsWith('.') && this.className === part.slice(1));
  }
  closest(selector) {
    for (let element = this; element; element = element.parent) {
      if (selector === element.tag || element.matches(selector)) return element;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector) || (selector.startsWith('[data-direction=') &&
          child.dataset.direction === selector.split('"')[1])) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  focus() {}
  get rows() { return this.children; }
}

test('table reorders nested values, preserves invalid edits, and clears resolved table errors', async t => {
  const previousDocument = global.document;
  t.after(() => { global.document = previousDocument; });
  global.document = { createElement: tag => new Element(tag) };
  const { createTableEditor } = await import('../public/table-editor.js');
  const editor = new Element();
  const tableBody = new Element('tbody');
  const tableButton = new Element();
  const rawButton = new Element();
  const breadcrumb = new Element();
  const errorElement = new Element();
  const errors = [];
  let changes = 0;
  const table = createTableEditor({
    editor, tableBody, tableButton, rawButton, breadcrumb, errorElement,
    rawView: new Element(), tableView: new Element(), addEntryButton: new Element(),
    onChange: () => changes++, onError: error => errors.push(error)
  });
  editor.value = '{';
  tableButton.emit('click');
  assert.match(errors.at(-1), /Cannot show table/);
  editor.value = '{"a":{"nested":1},"b":[1,{"deep":2}],"c":3}';
  table.refreshFromEditor();
  assert.equal(errors.at(-1), '');
  tableButton.emit('click');

  const dataTransfer = { setData() {} };
  const first = tableBody.rows[0];
  tableBody.emit('dragstart', { target: first.querySelector('.table-editor-drag'), dataTransfer });
  let prevented = false;
  tableBody.emit('dragover', { target: tableBody.rows[2], dataTransfer, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  tableBody.emit('drop', { target: tableBody.rows[2], preventDefault() {} });
  assert.deepEqual(Object.keys(JSON.parse(editor.value)), ['b', 'c', 'a']);
  assert.deepEqual(JSON.parse(editor.value).a, { nested: 1 });
  assert.equal(changes, 1);

  tableBody.emit('click', { target: tableBody.rows[0].querySelector('.table-editor-open') });
  tableBody.emit('click', { target: tableBody.rows[1].querySelector('.table-editor-move') });
  assert.deepEqual(JSON.parse(editor.value).b, [{ deep: 2 }, 1]);
  tableBody.emit('click', { target: tableBody.rows[0].querySelector('.table-editor-open') });
  assert.equal(tableBody.rows[0].querySelector('.table-editor-key').value, 'deep');

  breadcrumb.emit('click', { target: breadcrumb.children[0] });
  const value = tableBody.rows[1].querySelector('.table-editor-value');
  value.value = '{';
  tableBody.emit('input', { target: value });
  const before = editor.value;
  tableBody.emit('click', { target: tableBody.rows[1].querySelector('.table-editor-move') });
  assert.equal(editor.value, before);
  assert.match(errorElement.textContent, /Invalid JSON value/);
  assert.equal(table.hasInvalidEdits(), true);
  rawButton.emit('click');
  assert.match(errors.at(-1), /Invalid JSON value/);
  table.refreshFromEditor();
  assert.equal(errors.at(-1), '');
  tableButton.emit('click');
  tableBody.rows[1].querySelector('.table-editor-value').value = '{';
  tableBody.emit('input', { target: tableBody.rows[1].querySelector('.table-editor-value') });
  assert.equal(table.hasInvalidEdits(), true);
  table.reset();
  assert.equal(table.hasInvalidEdits(), false);
  assert.equal(errorElement.hidden, true);
});

test('object integer-index properties cannot be moved out of their standard order', async t => {
  const previousDocument = global.document;
  t.after(() => { global.document = previousDocument; });
  global.document = { createElement: tag => new Element(tag) };
  const { createTableEditor } = await import('../public/table-editor.js');
  const editor = new Element();
  editor.value = '{"1":"one","2":"two","x":3}';
  const tableBody = new Element('tbody');
  const tableButton = new Element();
  const errorElement = new Element();
  createTableEditor({
    editor, tableBody, tableButton, errorElement,
    rawButton: new Element(), breadcrumb: new Element(), rawView: new Element(),
    tableView: new Element(), addEntryButton: new Element(), onChange() {}, onError() {}
  });
  tableButton.emit('click');
  tableBody.emit('click', { target: tableBody.rows[1].querySelector('.table-editor-move') });
  assert.deepEqual(Object.keys(JSON.parse(editor.value)), ['1', '2', 'x']);
  assert.match(errorElement.textContent, /always sorted/);
});
