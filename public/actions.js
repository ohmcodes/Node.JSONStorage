import { $, clearEditor, hasUnsavedEditorContent, keyFieldError, keyNotice, message, parsed, showGeneratedKey, showSavedBinId, state, storeEditorDraft, ui } from './core.js';
import { apiTarget, headers, request, sendApiRequest } from './api.js';
import { forgetSavedBin, getSavedBin, rememberSavedBin } from './bins.js';
import { refreshBinCount } from './bin-count.js';

export function clearJson() {
  if ((ui.editor.value || hasUnsavedEditorContent()) && !confirm('Clear the JSON editor? This cannot be undone.')) return;
  clearEditor();
  ui.editor.focus();
  message('Editor cleared');
}

export function validateJson() {
  parsed();
  message('Valid JSON');
}

export function formatJson() {
  ui.editor.value = JSON.stringify(parsed(), null, 2);
  storeEditorDraft();
  message('JSON formatted');
}

export function compactJson() {
  ui.editor.value = JSON.stringify(parsed());
  storeEditorDraft();
  message('JSON compacted');
}

export async function repairJson() {
  const result = await request('/api/repair', { method: 'POST', body: ui.editor.value });
  ui.editor.value = result.json;
  storeEditorDraft();
  message('JSON repaired and formatted');
}

export function downloadJson() {
  const blob = new Blob([JSON.stringify(parsed(), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bin.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message('JSON downloaded');
}

export async function generateKey() {
  if (ui.key.value && !confirm('Generating a new key does not recover the old key. Continue?')) return;
  const result = await request('/api/accounts', { method: 'POST' });
  showGeneratedKey(result.secretKey);
  message('Account created. Copy the hidden key and save it securely.', 'success', 'key');
}

export function toggleKey() {
  ui.key.type = ui.key.type === 'password' ? 'text' : 'password';
  const label = ui.key.type === 'password' ? 'Show secret key' : 'Hide secret key';
  $('toggle-key').setAttribute('aria-label', label);
  $('toggle-key').setAttribute('title', label);
  $('toggle-key').setAttribute('aria-pressed', String(ui.key.type === 'text'));
}

export async function copyKey() {
  if (!ui.key.value) throw keyFieldError('Generate or enter a secret key first');
  await navigator.clipboard.writeText(ui.key.value);
  state.copiedKeyValue = ui.key.value.trim();
  if (ui.key.value === state.generatedKey) state.generatedKeyCopied = true;
  keyNotice('Copied successfully in this tab. Save it in a password manager.', 'success');
}

export async function copyBinId() {
  if (!$('saved-bin-id').value) throw new Error('Save a bin first');
  await navigator.clipboard.writeText($('saved-bin-id').value);
  message('Bin ID copied', 'success', 'storage');
}

export function toggleBinId() {
  const binId = $('saved-bin-id');
  binId.type = binId.type === 'password' ? 'text' : 'password';
  const label = binId.type === 'password' ? 'Show bin ID' : 'Hide bin ID';
  $('toggle-bin-id').setAttribute('aria-label', label);
  $('toggle-bin-id').setAttribute('title', label);
  $('toggle-bin-id').setAttribute('aria-pressed', String(binId.type === 'text'));
}

export async function sendTestRequest() {
  const method = ui.apiMethod.value;
  const target = apiTarget();
  if (method === 'DELETE' && !confirm('Delete this bin? The owner key or its creating browser cookie is required.')) return;
  const value = await sendApiRequest(method, target.pathname + target.search,
    ['POST', 'PUT', 'PATCH'].includes(method) ? $('api-body').value : undefined,
    ui.apiKeyHeader.value.trim() || ui.key.value.trim());
  if ((method === 'POST' && target.pathname === '/api/bins') || method === 'DELETE') refreshBinCount();
  if (method === 'POST' && target.pathname === '/api/bins' && value.id) {
    state.currentSavedBinId = value.id;
    showSavedBinId(value.id);
    rememberSavedBin(value.id, value.visibility || 'public');
  }
  const updatedBin = /^\/api\/bins\/([a-f0-9]{32})$/.exec(target.pathname);
  if (updatedBin && ['PUT', 'PATCH'].includes(method)) {
    state.currentSavedBinId = updatedBin[1];
    showSavedBinId(updatedBin[1]);
    const savedEntry = getSavedBin(updatedBin[1]);
    if (savedEntry) rememberSavedBin(updatedBin[1], savedEntry.visibility);
  }
  if (method === 'DELETE' && updatedBin) {
    forgetSavedBin(updatedBin[1]);
    if (state.currentSavedBinId === updatedBin[1]) clearCurrentBin();
  }
  if (method === 'POST' && target.pathname === '/api/accounts' && value.secretKey) {
    showGeneratedKey(value.secretKey);
  }
  message('Request completed', 'success', 'api');
}

export async function saveBin() {
  const visibility = document.querySelector('input[name="visibility"]:checked').value;
  const savedBinId = state.currentSavedBinId;
  const parsedValue = parsed();
  ui.editor.value = JSON.stringify(parsedValue, null, 2);
  storeEditorDraft();
  if (visibility === 'private' && !savedBinId && !ui.key.value.trim()) {
    const account = await request('/api/accounts', { method: 'POST' });
    showGeneratedKey(account.secretKey);
    $('key-copy-state').textContent = 'A key was generated. Copy and save it now; the bin will not be created until you press Save again.';
  }
  if (visibility === 'private' && !ui.key.value.trim()) {
    throw keyFieldError('Private bins require the owner key. Enter or generate one in Authentication.');
  }
  if (visibility === 'private' && !savedBinId && state.copiedKeyValue !== ui.key.value.trim()) {
    throw keyFieldError('Private bin not saved. Copy the owner key with the Copy button, then press Save bin again.');
  }
  const method = savedBinId ? 'PUT' : 'POST';
  const target = savedBinId
    ? `/api/bins/${savedBinId}?visibility=${visibility}`
    : `/api/bins?visibility=${visibility}`;
  const value = await sendApiRequest(method, target, JSON.stringify(parsedValue));
  if (!$('key-error').hidden) keyNotice('');
  if (method === 'POST') refreshBinCount();
  storeEditorDraft(true);
  const id = method === 'POST' ? value.id : savedBinId;
  const persisted = rememberSavedBin(id, method === 'POST' ? value.visibility : visibility);
  state.currentSavedBinId = id;
  showSavedBinId(id);
  const copyKeyReminder = state.generatedKey && ui.key.value === state.generatedKey && !state.generatedKeyCopied
    ? ' Copy the generated owner key now; it cannot be recovered.'
    : '';
  message(persisted
    ? (method === 'POST' ? 'Bin saved and added to this browser’s list.' : 'Bin updated.') + copyKeyReminder
    : 'Bin saved remotely, but browser storage is unavailable; copy its ID to keep track of it.', 'success', 'storage');
}

export function clearCurrentBin() {
  state.currentSavedBinId = '';
  $('saved-bin-field').hidden = true;
  $('saved-bin-id').value = '';
}
