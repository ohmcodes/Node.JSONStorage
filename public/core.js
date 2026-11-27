import { createDraftController } from './draft.js';
import { createTableEditor } from './table-editor.js';

export const $ = id => document.getElementById(id);

export const ui = {
  editor: $('editor'),
  status: $('status'),
  key: $('key'),
  apiMethod: $('api-method'),
  apiUrl: $('api-url'),
  apiKeyHeader: $('api-key-header'),
  responseOutput: $('response'),
};

export const state = {
  generatedKey: '',
  generatedKeyCopied: false,
  copiedKeyValue: '',
  currentSavedBinId: ''
};

const draftController = createDraftController({
  sessionStorage,
  editor: ui.editor,
  draftState: $('draft-state')
});

const tableEditor = createTableEditor({
  editor: ui.editor,
  rawView: $('raw-editor-view'),
  tableView: $('table-editor-view'),
  tableBody: $('table-editor-rows'),
  breadcrumb: $('table-editor-breadcrumb'),
  rawButton: $('editor-mode-raw'),
  tableButton: $('editor-mode-table'),
  addEntryButton: $('table-editor-add'),
  errorElement: $('table-editor-error'),
  onChange: () => draftController.store(),
  onError: text => message(text, 'error')
});

export function showSavedBinId(binId) {
  if (!/^[a-f0-9]{32}$/.test(binId)) return;
  $('saved-bin-id').value = binId;
  $('saved-bin-id').type = 'password';
  $('toggle-bin-id').setAttribute('aria-label', 'Show bin ID');
  $('toggle-bin-id').setAttribute('title', 'Show bin ID');
  $('toggle-bin-id').setAttribute('aria-pressed', 'false');
  $('saved-bin-field').hidden = false;
  $('storage-panel').open = true;
}

export function storeEditorDraft(saved = false) {
  draftController.store(saved);
  tableEditor.refreshFromEditor();
}

export function hasUnsavedEditorContent() {
  return draftController.hasUnsavedEditorContent() || tableEditor.hasInvalidEdits();
}

export function message(text, status = 'success', area = 'editor') {
  const targets = {
    editor: ui.status,
    storage: $('storage-status'),
    api: $('api-status'),
    key: $('key-copy-state')
  };
  const target = targets[area] || ui.status;
  target.textContent = text;
  target.dataset.state = status;
}

export function keyNotice(text, status = '') {
  const errorNotice = $('key-error');
  if (status === 'error') {
    errorNotice.textContent = text;
    errorNotice.hidden = false;
    return;
  }
  errorNotice.textContent = '';
  errorNotice.hidden = true;
  const notice = $('key-copy-state');
  notice.textContent = text;
  notice.dataset.state = status;
}

export function keyFieldError(text) {
  keyNotice(text, 'error');
  const error = new Error(text);
  error.keyFieldNotice = true;
  return error;
}

export function revealAuthPanel() {
  $('auth-panel').hidden = false;
}

export function privateVisibilitySelected() {
  return document.querySelector('input[name="visibility"]:checked').value === 'private';
}

export function selectPrivateVisibility() {
  const privateOption = document.querySelector('input[name="visibility"][value="private"]');
  privateOption.checked = true;
  privateOption.dispatchEvent(new Event('change'));
}

export function parsed() {
  tableEditor.syncToEditor();
  try {
    return JSON.parse(ui.editor.value);
  } catch (error) {
    const source = ui.editor.value;
    const positionMatch = error.message.match(/position\s+(\d+)/i);
    const locationMatch = error.message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    let position = positionMatch ? Number(positionMatch[1]) : source.length;
    if (!positionMatch && locationMatch) {
      const targetLine = Number(locationMatch[1]);
      const targetColumn = Number(locationMatch[2]);
      position = 0;
      for (let line = 1; line < targetLine; line++) {
        const nextLine = source.indexOf('\n', position);
        if (nextLine === -1) break;
        position = nextLine + 1;
      }
      position += targetColumn - 1;
    } else if (!positionMatch) {
      const snippetMatch = error.message.match(/, ([\s\S]+) is not valid JSON$/);
      const tokenMatch = error.message.match(/Unexpected token ['"](.+?)['"]/i);
      if (snippetMatch && tokenMatch) {
        let snippet = snippetMatch[1].replace(/^\.\.\./, '');
        if (snippet.startsWith('"') && snippet.endsWith('"')) snippet = snippet.slice(1, -1);
        const snippetStart = source.indexOf(snippet);
        const tokenOffset = snippet.indexOf(tokenMatch[1]);
        if (snippetStart !== -1 && tokenOffset !== -1) position = snippetStart + tokenOffset;
      }
    }
    const before = source.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    ui.editor.focus();
    ui.editor.setSelectionRange(position, Math.min(position + 1, source.length));
    throw new Error(`Invalid JSON at line ${line}, column ${column}: ${error.message}`);
  }
}

export function showGeneratedKey(secretKey) {
  ui.key.value = secretKey;
  state.generatedKey = secretKey;
  state.generatedKeyCopied = false;
  state.copiedKeyValue = '';
  ui.key.type = 'password';
  $('toggle-key').setAttribute('aria-label', 'Show secret key');
  $('toggle-key').setAttribute('title', 'Show secret key');
  $('toggle-key').setAttribute('aria-pressed', 'false');
  keyNotice('Not copied yet. Copy this key before refreshing the page.');
  revealAuthPanel();
  $('key-help-text').hidden = false;
  $('key-help').setAttribute('aria-expanded', 'true');
}
