import { $, hasUnsavedEditorContent, keyFieldError, keyNotice, message, showSavedBinId, state, storeEditorDraft, ui } from './core.js';
import { headers, sendApiRequest, request } from './api.js';
import { reconcileEntries } from './bin-sync.js';
import { refreshBinCount } from './bin-count.js';

const savedBinsStorageKey = 'jsonstorage.savedBins';
let savedBins = loadSavedBins();

function loadSavedBins() {
  try {
    const entries = JSON.parse(localStorage.getItem(savedBinsStorageKey) || '[]');
    return Array.isArray(entries)
      ? entries.filter(entry => entry && /^[a-f0-9]{32}$/.test(entry.id) && ['public', 'private'].includes(entry.visibility))
      : [];
  } catch {
    return [];
  }
}

function persistSavedBins() {
  try {
    localStorage.setItem(savedBinsStorageKey, JSON.stringify(savedBins));
    return true;
  } catch {
    return false;
  }
}

export function getSavedBins() {
  return [...savedBins];
}

export function getSavedBin(id) {
  return savedBins.find(entry => entry.id === id);
}

export function rememberSavedBin(id, visibility) {
  savedBins = [{ id, visibility }, ...savedBins.filter(entry => entry.id !== id)];
  const persisted = persistSavedBins();
  renderSavedBins();
  return persisted;
}

export function forgetSavedBin(id) {
  savedBins = savedBins.filter(entry => entry.id !== id);
  const persisted = persistSavedBins();
  renderSavedBins();
  return persisted;
}

function forgetExpiredBin(entry) {
  forgetSavedBin(entry.id);
  if (state.currentSavedBinId === entry.id) {
    state.currentSavedBinId = '';
    $('saved-bin-field').hidden = true;
    $('saved-bin-id').value = '';
  }
  message('This bin expired after 30 days without activity and was removed from this browser list.', 'success', 'storage');
}

export function renderSavedBins() {
  const list = $('saved-bin-list');
  list.replaceChildren();
  $('saved-bin-empty').hidden = savedBins.length > 0;
  for (const entry of savedBins) {
    const item = document.createElement('li');
    item.className = 'saved-bin-item';
    const label = document.createElement('span');
    label.textContent = `${entry.visibility === 'private' ? 'Private' : 'Public'} bin, ID ending ${entry.id.slice(-6)}`;
    const actions = document.createElement('div');
    actions.className = 'saved-bin-actions';
    for (const action of ['use', 'delete']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action === 'use' ? 'Use' : 'Delete';
      button.dataset.binAction = action;
      button.dataset.binId = entry.id;
      actions.append(button);
    }
    item.append(label, actions);
    list.append(item);
  }
}

export async function reconcileSavedBins() {
  const snapshot = [...savedBins];
  if (!snapshot.length) return;
  const { entries, missingCount } = await reconcileEntries(snapshot, async entry => {
    const response = await fetch(`/api/bins/${entry.id}`, { method: 'HEAD', cache: 'no-store' });
    if (response.status === 404) return { missing: true };
    return { visibility: response.headers.get('X-Bin-Visibility') };
  });
  if (JSON.stringify(savedBins) !== JSON.stringify(snapshot)) return;
  const previous = JSON.stringify(savedBins);
  savedBins = entries;
  if (JSON.stringify(savedBins) === previous) return;

  const persisted = persistSavedBins();
  renderSavedBins();
  if (missingCount) {
    message(persisted
      ? `Removed ${missingCount} bin${missingCount === 1 ? '' : 's'} no longer present on the server.`
      : 'Removed missing bins for this session; browser storage could not be updated.', persisted ? 'success' : 'error', 'storage');
  }
}

export async function loadBinById() {
  const id = $('load-bin-id').value.trim();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Enter a valid 32-character bin ID.');
  await loadBin(id);
}

export async function reloadCurrentBin() {
  if (!state.currentSavedBinId) throw new Error('Load or save a bin before reloading.');
  await loadBin(state.currentSavedBinId, true);
}

async function loadBin(id, requireCurrent = false) {
  const response = await fetch(`/api/bins/${id}`, { method: 'HEAD', cache: 'no-store' });
  if (response.status === 404) throw new Error('Bin not found. Check the ID or the bin may have expired.');
  const visibility = response.headers.get('X-Bin-Visibility');
  if (!((response.ok && ['public', 'private'].includes(visibility)) || (response.status === 401 && visibility === 'private'))) {
    throw new Error(`Could not check bin visibility (${response.status}).`);
  }
  await useSavedBin({ id, visibility }, { remember: true, requireCurrent });
}

export async function useSavedBin(entry, { remember = false, requireCurrent = false } = {}) {
  if (entry.visibility === 'private' && !ui.key.value.trim()) {
    throw keyFieldError('This private bin needs its owner key. Enter it in Authentication, then load the bin again.');
  }
  let value;
  try {
    value = await request(`/api/bins/${entry.id}`, { cache: 'no-store', headers: headers(entry.visibility === 'private' ? ui.key.value.trim() : '') });
  } catch (error) {
    if (error.status === 404) {
      if (getSavedBin(entry.id)) forgetExpiredBin(entry);
      else message('Bin not found. Check the ID or the bin may have expired.', 'error', 'storage');
      return;
    }
    if (error.status === 401) {
      throw keyFieldError('A valid owner key is required. Enter it in Authentication, then load the bin again.');
    }
    throw error;
  }
  if (requireCurrent && state.currentSavedBinId !== entry.id) {
    throw new Error('The current bin changed while reloading. Reload the selected bin again.');
  }
  if (hasUnsavedEditorContent() && !confirm('Loading a bin will replace your unsaved editor content. Continue?')) return;
  keyNotice('');
  ui.editor.value = JSON.stringify(value, null, 2);
  storeEditorDraft(true, true);
  state.currentSavedBinId = entry.id;
  showSavedBinId(entry.id);
  ui.apiMethod.value = 'GET';
  ui.apiUrl.value = `/api/bins/${entry.id}`;
  $('api-panel').open = true;
  const visibilityOption = document.querySelector(`input[name="visibility"][value="${entry.visibility}"]`);
  visibilityOption.checked = true;
  visibilityOption.dispatchEvent(new Event('change'));
  $('storage-panel').open = true;
  ui.editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
  ui.editor.focus();
  const persisted = !remember || rememberSavedBin(entry.id, entry.visibility);
  message(persisted
    ? `${entry.visibility === 'private' ? 'Private' : 'Public'} bin loaded into the editor`
    : 'Bin loaded, but browser storage is unavailable; keep a copy of its ID.', persisted ? 'success' : 'error', 'storage');
}

export async function deleteSavedBin(entry) {
  if (entry.visibility === 'private' && !ui.key.value.trim()) {
    throw keyFieldError('Enter the owner key in Authentication to delete this private bin.');
  }
  if (!confirm(`Delete this ${entry.visibility} bin ending ${entry.id.slice(-6)}? This cannot be undone.`)) return;
  try {
    await sendApiRequest('DELETE', `/api/bins/${entry.id}`);
  } catch (error) {
    if (error.status === 404) {
      forgetExpiredBin(entry);
      return;
    }
    throw error;
  }
  const persisted = forgetSavedBin(entry.id);
  refreshBinCount();
  if (state.currentSavedBinId === entry.id) {
    state.currentSavedBinId = '';
    $('saved-bin-field').hidden = true;
    $('saved-bin-id').value = '';
  }
  message(persisted ? 'Bin deleted from storage and this browser' : 'Bin deleted from storage; browser list could not be updated', 'success', 'storage');
}
