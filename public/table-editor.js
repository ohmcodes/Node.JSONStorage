function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

export function createTableEditor({
  editor,
  rawView,
  tableView,
  tableBody,
  breadcrumb,
  rawButton,
  tableButton,
  addEntryButton,
  errorElement,
  onChange,
  onError
}) {
  let mode = 'raw';
  let path = [];
  let rootKind = '';
  let invalidEdits = false;

  function showMode(nextMode) {
    mode = nextMode;
    rawView.hidden = mode !== 'raw';
    tableView.hidden = mode !== 'table';
    rawButton.setAttribute('aria-pressed', String(mode === 'raw'));
    tableButton.setAttribute('aria-pressed', String(mode === 'table'));
  }

  function setError(text) {
    errorElement.textContent = text;
    errorElement.hidden = !text;
  }

  function parseEditor() {
    try {
      return JSON.parse(editor.value);
    } catch (error) {
      throw new Error(`Cannot show table: ${error.message}`);
    }
  }

  function valueAtPath(root, targetPath = path) {
    return targetPath.reduce((value, key) => value[key], root);
  }

  function setAtPath(root, targetPath, value) {
    if (!targetPath.length) return value;
    const parent = valueAtPath(root, targetPath.slice(0, -1));
    Object.defineProperty(parent, targetPath[targetPath.length - 1], {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
    return root;
  }

  function renderBreadcrumb(root) {
    breadcrumb.replaceChildren();
    const levels = [{ label: 'JSON', path: [] }];
    let value = root;
    path.forEach((key, index) => {
      const parentKind = jsonType(value);
      value = value[key];
      const label = parentKind === 'array' ? `[${key}]` : String(key);
      levels.push({ label, path: path.slice(0, index + 1) });
    });

    levels.forEach((level, index) => {
      if (index) {
        const separator = document.createElement('span');
        separator.className = 'table-editor-breadcrumb-separator';
        separator.textContent = '›';
        separator.setAttribute('aria-hidden', 'true');
        breadcrumb.append(separator);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'table-editor-breadcrumb';
      button.textContent = level.label;
      button.dataset.pathDepth = String(level.path.length);
      button.setAttribute('aria-current', index === levels.length - 1 ? 'location' : 'false');
      breadcrumb.append(button);
    });
  }

  function renderEntry(value, label, parentKind) {
    const row = document.createElement('tr');
    const keyCell = document.createElement('td');
    if (parentKind === 'object') {
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'table-editor-key';
      keyInput.value = label;
      keyInput.setAttribute('aria-label', 'Property name');
      keyCell.append(keyInput);
    } else {
      keyCell.textContent = label;
    }

    const valueCell = document.createElement('td');
    const kind = jsonType(value);
    if (kind === 'object' || kind === 'array') {
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'table-editor-open';
      openButton.dataset.key = label;
      openButton.textContent = kind === 'array'
        ? `Array (${value.length} items) ›`
        : `Object (${Object.keys(value).length} properties) ›`;
      openButton.setAttribute('aria-label', `Open ${kind} ${label}`);
      valueCell.append(openButton);
    } else {
      const valueInput = document.createElement('textarea');
      valueInput.className = 'table-editor-value';
      valueInput.value = JSON.stringify(value, null, 2);
      valueInput.setAttribute('aria-label', `JSON value for ${label}`);
      valueCell.append(valueInput);
    }
    row.append(keyCell, valueCell);

    if (parentKind === 'object' || parentKind === 'array') {
      const actionCell = document.createElement('td');
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'table-editor-remove';
      removeButton.textContent = 'Remove';
      removeButton.setAttribute('aria-label', `Remove ${parentKind === 'array' ? `item ${label}` : `property ${label}`}`);
      actionCell.append(removeButton);
      row.append(actionCell);
    }
    return row;
  }

  function render(root) {
    const value = valueAtPath(root);
    rootKind = jsonType(value);
    renderBreadcrumb(root);
    tableBody.replaceChildren();
    if (rootKind === 'object') {
      Object.entries(value).forEach(([key, child]) => tableBody.append(renderEntry(child, key, rootKind)));
      addEntryButton.textContent = 'Add property';
      addEntryButton.hidden = false;
    } else if (rootKind === 'array') {
      value.forEach((child, index) => tableBody.append(renderEntry(child, String(index), rootKind)));
      addEntryButton.textContent = 'Add item';
      addEntryButton.hidden = false;
    } else {
      const row = document.createElement('tr');
      const keyCell = document.createElement('td');
      keyCell.textContent = path.length ? String(path[path.length - 1]) : '$';
      const valueCell = document.createElement('td');
      const valueInput = document.createElement('textarea');
      valueInput.className = 'table-editor-value';
      valueInput.value = JSON.stringify(value, null, 2);
      valueInput.setAttribute('aria-label', 'JSON value');
      valueCell.append(valueInput);
      row.append(keyCell, valueCell);
      tableBody.append(row);
      addEntryButton.hidden = true;
    }
    invalidEdits = false;
    setError('');
  }

  function readTable() {
    const rows = [...tableBody.rows];
    if (rootKind === 'object') {
      const result = Object.create(null);
      for (const [index, row] of rows.entries()) {
        const key = row.querySelector('.table-editor-key').value;
        if (Object.hasOwn(result, key)) {
          throw new Error(`Property names must be unique (duplicate: "${key}").`);
        }
        result[key] = readValue(row, index);
      }
      return result;
    }
    if (rootKind === 'array') return rows.map((row, index) => readValue(row, index));
    if (rows.length !== 1) throw new Error('The JSON value could not be read.');
    return readValue(rows[0], 0);
  }

  function readValue(row, index) {
    const nested = row.querySelector('.table-editor-open');
    if (nested) {
      const root = parseEditor();
      const oldValue = valueAtPath(root, [...path, nested.dataset.key]);
      return oldValue;
    }
    try {
      return JSON.parse(row.querySelector('.table-editor-value').value);
    } catch (error) {
      throw new Error(`Invalid JSON value in table row ${Number(index) + 1}: ${error.message}`);
    }
  }

  function updateOpenButton(row) {
    const keyInput = row.querySelector('.table-editor-key');
    const openButton = row.querySelector('.table-editor-open');
    if (!keyInput || !openButton) return;
    const child = valueAtPath(parseEditor(), [...path, keyInput.value]);
    const kind = jsonType(child);
    openButton.dataset.key = keyInput.value;
    openButton.textContent = kind === 'array'
      ? `Array (${child.length} items) ›`
      : `Object (${Object.keys(child).length} properties) ›`;
    openButton.setAttribute('aria-label', `Open ${kind} ${keyInput.value}`);
  }

  function syncToEditor() {
    if (mode !== 'table') return;
    try {
      const root = parseEditor();
      editor.value = JSON.stringify(setAtPath(root, path, readTable()), null, 2);
      invalidEdits = false;
      setError('');
    } catch (error) {
      invalidEdits = true;
      setError(error.message);
      throw error;
    }
  }

  function refreshFromEditor() {
    if (mode !== 'table') return;
    try {
      const root = parseEditor();
      valueAtPath(root);
      render(root);
    } catch (error) {
      onError(error.message);
      showMode('raw');
    }
  }

  function selectMode(nextMode) {
    if (nextMode === mode) return;
    if (nextMode === 'table') {
      try {
        path = [];
        render(parseEditor());
      } catch (error) {
        onError(error.message);
        return;
      }
    } else {
      try {
        syncToEditor();
      } catch (error) {
        onError(error.message);
      }
      invalidEdits = false;
      setError('');
    }
    showMode(nextMode);
  }

  function addEntry() {
    try {
      syncToEditor();
      const root = parseEditor();
      const value = valueAtPath(root);
      if (rootKind === 'object') {
        let key = 'newProperty';
        let suffix = 1;
        while (Object.hasOwn(value, key)) key = `newProperty${suffix++}`;
        value[key] = null;
      } else if (rootKind === 'array') {
        value.push(null);
      } else {
        return;
      }
      editor.value = JSON.stringify(root, null, 2);
      render(root);
      onChange();
    } catch (error) {
      setError(error.message);
    }
  }

  function removeEntry(button) {
    const row = button.closest('tr');
    const index = [...tableBody.rows].indexOf(row);
    try {
      syncToEditor();
      const root = parseEditor();
      const value = valueAtPath(root);
      if (rootKind === 'object') delete value[row.querySelector('.table-editor-key').value];
      else if (rootKind === 'array') value.splice(index, 1);
      editor.value = JSON.stringify(root, null, 2);
      render(root);
      onChange();
    } catch (error) {
      setError(error.message);
    }
  }

  function openEntry(button) {
    try {
      syncToEditor();
      const row = button.closest('tr');
      const key = rootKind === 'array'
        ? Number(row.cells[0].textContent)
        : row.querySelector('.table-editor-key').value;
      path = [...path, key];
      render(parseEditor());
    } catch (error) {
      setError(error.message);
    }
  }

  function navigateBreadcrumb(button) {
    try {
      syncToEditor();
      path = path.slice(0, Number(button.dataset.pathDepth));
      render(parseEditor());
    } catch (error) {
      setError(error.message);
    }
  }

  rawButton.addEventListener('click', () => selectMode('raw'));
  tableButton.addEventListener('click', () => selectMode('table'));
  addEntryButton.addEventListener('click', addEntry);
  tableBody.addEventListener('input', event => {
    if (!event.target.matches('.table-editor-key, .table-editor-value')) return;
    try {
      syncToEditor();
      if (event.target.matches('.table-editor-key')) updateOpenButton(event.target.closest('tr'));
      onChange();
    } catch {
      invalidEdits = true;
    }
  });
  tableBody.addEventListener('click', event => {
    const openButton = event.target.closest('.table-editor-open');
    if (openButton) return openEntry(openButton);
    const removeButton = event.target.closest('.table-editor-remove');
    if (removeButton) removeEntry(removeButton);
  });
  breadcrumb.addEventListener('click', event => {
    const button = event.target.closest('.table-editor-breadcrumb');
    if (button) navigateBreadcrumb(button);
  });

  return {
    syncToEditor,
    refreshFromEditor,
    hasInvalidEdits: () => mode === 'table' && invalidEdits
  };
}
