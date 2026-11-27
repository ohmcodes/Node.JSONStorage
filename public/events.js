import { $, hasUnsavedEditorContent, message, state, storeEditorDraft, ui } from './core.js';
import * as actions from './actions.js';
import { deleteSavedBin, getSavedBin, getSavedBins, loadBinById, reconcileSavedBins, reloadCurrentBin, renderSavedBins, useSavedBin } from './bins.js';
import { clearLiveLogs, connectLiveLogs, renderLiveLogs, stopLiveLogs } from './live-logs.js';
import { configureDonationLinks } from './donations.js';
import { initializeTheme } from './theme.js';
import { refreshBinCount } from './bin-count.js';

function bindAction(id, callback, area = 'editor') {
  $(id).addEventListener('click', async () => {
    try {
      await callback();
    } catch (error) {
      if (!error.keyFieldNotice) message(error.message, 'error', area);
    }
  });
}

function bindVisibilityEvents() {
  document.querySelectorAll('input[name="visibility"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isPrivate = document.querySelector('input[name="visibility"]:checked').value === 'private';
      $('visibility-note').textContent = isPrivate
        ? 'Private bins require the owner key to save, read, edit, and delete. Enter or generate the key in Authentication.'
        : 'Public bins can be read without a key. Keyless bins use this browser’s owner cookie for updates and deletes; account-owned bins require their owner key.';
      if (isPrivate) $('storage-panel').open = true;
    });
  });
}

function bindEndpointLinks() {
  document.querySelectorAll('.endpoint-use').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      ui.apiMethod.value = link.dataset.method;
      const binId = selectedApiBinId();
      ui.apiUrl.value = link.dataset.endpoint.replace(/YOUR_BIN_ID/g, binId || 'YOUR_BIN_ID');
      updateApiBodyVisibility();
      const endpoint = new URL(link.dataset.endpoint, window.location.origin);
      if (link.dataset.method === 'POST' && endpoint.pathname === '/api/bins') {
        state.currentSavedBinId = '';
        $('saved-bin-field').hidden = true;
        $('saved-bin-id').value = '';
      }
      $('api-panel').open = true;
      $('api-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      ui.apiUrl.focus();
    });
  });
}

function updateApiBodyVisibility() {
  $('api-body-field').hidden = !['POST', 'PUT', 'PATCH'].includes(ui.apiMethod.value);
}

function selectedApiBinId() {
  return state.currentSavedBinId || $('saved-bin-id').value.trim() || getSavedBins()[0]?.id || '';
}

function populateApiUrlForMethod() {
  const binId = selectedApiBinId();
  if (!binId) return;
  const endpoint = ui.apiUrl.value.trim();
  const binEndpoint = `/api/bins/${binId}`;
  const isSelectedBinEndpoint = endpoint === binEndpoint || endpoint === `${binEndpoint}/query`;
  if (!endpoint.includes('YOUR_BIN_ID') && !/^\/api\/bins(?:\?.*)?$/.test(endpoint) && !isSelectedBinEndpoint) return;
  ui.apiUrl.value = ui.apiMethod.value === 'POST' ? `${binEndpoint}/query` : binEndpoint;
}

function bindApiTesterEvents() {
  ui.apiMethod.addEventListener('change', () => {
    updateApiBodyVisibility();
    populateApiUrlForMethod();
  });
  updateApiBodyVisibility();
}

function bindSavedBinEvents() {
  $('saved-bin-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-bin-action]');
    if (!button) return;
    const entry = getSavedBin(button.dataset.binId);
    if (!entry) return;
    const operation = button.dataset.binAction === 'use' ? useSavedBin : deleteSavedBin;
    operation(entry).catch(error => {
      if (!error.keyFieldNotice) message(error.message, 'error', 'storage');
    });
  });
}

function bindEditorEvents() {
  window.addEventListener('beforeunload', event => {
    const enteredKey = ui.key.value.trim();
    const uncopiedKey = enteredKey && state.copiedKeyValue !== enteredKey;
    if (!hasUnsavedEditorContent() && !uncopiedKey) return;
    event.preventDefault();
    event.returnValue = 'Unsaved JSON or an uncopied key may be lost.';
  });
  ui.editor.addEventListener('input', () => storeEditorDraft());
  $('upload').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) return message('File exceeds the 1 MB editor upload limit');
    try {
      ui.editor.value = await file.text();
      storeEditorDraft();
      message('File loaded');
    } catch {
      message('Could not read the file', 'error');
    }
  });
}

function bindActions() {
  bindAction('clear-json', actions.clearJson);
  bindAction('validate', actions.validateJson);
  bindAction('format', actions.formatJson);
  bindAction('compact', actions.compactJson);
  bindAction('repair', actions.repairJson);
  bindAction('download', actions.downloadJson);
  bindAction('generate', actions.generateKey, 'key');
  bindAction('toggle-key', actions.toggleKey, 'key');
  bindAction('copy-key', actions.copyKey, 'key');
  bindAction('copy-bin-id', actions.copyBinId, 'storage');
  bindAction('toggle-bin-id', actions.toggleBinId, 'storage');
  bindAction('send-request', actions.sendTestRequest, 'api');
  bindAction('save-bin', actions.saveBin, 'storage');
  bindAction('load-bin', loadBinById, 'storage');
  bindAction('reload-bin', reloadCurrentBin, 'storage');
  $('new-bin').addEventListener('click', () => {
    state.currentSavedBinId = '';
    $('saved-bin-field').hidden = true;
    $('saved-bin-id').value = '';
    message('Ready to create a new bin', 'success', 'storage');
  });
  $('key-help').addEventListener('click', () => {
    const help = $('key-help-text');
    help.hidden = !help.hidden;
    $('key-help').setAttribute('aria-expanded', String(!help.hidden));
  });
}

function bindLogEvents() {
  $('start-logs').addEventListener('click', () => {
    connectLiveLogs().catch(error => { $('logs-status').textContent = error.message; });
  });
  $('stop-logs').addEventListener('click', stopLiveLogs);
  $('clear-logs').addEventListener('click', clearLiveLogs);
  $('log-bin-filter').addEventListener('input', renderLiveLogs);
}

export function initializeApp() {
  initializeTheme({ document, window, storage: localStorage });
  bindEditorEvents();
  bindActions();
  bindSavedBinEvents();
  bindLogEvents();
  bindApiTesterEvents();
  bindVisibilityEvents();
  bindEndpointLinks();
  $('copyright-year').textContent = String(new Date().getFullYear());
  renderSavedBins();
  reconcileSavedBins();
  window.addEventListener('focus', reconcileSavedBins);
  refreshBinCount();
  window.addEventListener('focus', refreshBinCount);
  window.setInterval(refreshBinCount, 60000);
  configureDonationLinks();
}
