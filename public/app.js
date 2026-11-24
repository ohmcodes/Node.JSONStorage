const $ = id => document.getElementById(id);
const editor = $('editor');
const status = $('status');
const key = $('key');
const apiMethod = $('api-method');
const apiUrl = $('api-url');
const apiKeyHeader = $('api-key-header');
const responseOutput = $('response');
const themeToggle = $('theme-toggle');
let generatedKey = '';
let generatedKeyCopied = false;
let copiedKeyValue = '';
let currentSavedBinId = '';
const savedBinsStorageKey = 'jsonstorage.savedBins';
let savedBins = loadSavedBins();
const liveLogSessionMs = 10 * 60 * 1000;
const liveLogIdleMs = 5 * 60 * 1000;
const editorDraftKey = 'jsonstorage.editorDraft';
let restoredDraft = null;
try {
  restoredDraft = JSON.parse(sessionStorage.getItem(editorDraftKey));
  if (!restoredDraft || typeof restoredDraft.value !== 'string') restoredDraft = null;
} catch {
  restoredDraft = null;
}

function showSavedBinId(binId) {
  if (!/^[a-f0-9]{32}$/.test(binId)) return;
  $('saved-bin-id').value = binId;
  $('saved-bin-id').type = 'password';
  $('toggle-bin-id').setAttribute('aria-label', 'Show bin ID');
  $('toggle-bin-id').setAttribute('title', 'Show bin ID');
  $('toggle-bin-id').setAttribute('aria-pressed', 'false');
  $('saved-bin-field').hidden = false;
  $('storage-panel').open = true;
}
if (restoredDraft) editor.value = restoredDraft.value;
let savedEditorValue = restoredDraft
  ? restoredDraft.saved ? restoredDraft.value : restoredDraft.value ? null : ''
  : editor.value;
let liveLogController = null;
const liveLogEvents = [];
let liveLogClearedAt = 0;
let liveLogInterval = null;
let liveLogStopReason = 'Disconnected';
let liveLogStartedAt = 0;
let liveLogLastResponseAt = 0;
let liveLogLastActivityAt = 0;

if (restoredDraft && restoredDraft.value) {
  $('draft-state').textContent = restoredDraft.saved
    ? 'Saved editor content restored from this tab.'
    : 'Unsaved draft restored from this tab.';
}

function storeEditorDraft(saved = false) {
  try {
    sessionStorage.setItem(editorDraftKey, JSON.stringify({ value: editor.value, saved }));
    $('draft-state').textContent = saved
      ? 'Saved editor content is kept in this tab.'
      : 'Draft saved in this tab. Refresh to restore it; closing the tab clears it.';
  } catch {
    $('draft-state').textContent = 'This browser could not store a draft. Save the bin or download the JSON before refreshing.';
  }
  if (saved) savedEditorValue = editor.value;
}

window.addEventListener('beforeunload', event => {
  const enteredKey = key.value.trim();
  const uncopiedKey = enteredKey && copiedKeyValue !== enteredKey;
  if (editor.value === savedEditorValue && !uncopiedKey) return;
  event.preventDefault();
  event.returnValue = 'Unsaved JSON or an uncopied key may be lost.';
});
editor.addEventListener('input', () => storeEditorDraft());
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let savedTheme;
try {
  savedTheme = localStorage.getItem('theme');
} catch {
  savedTheme = null;
}
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme;
}

function updateThemeToggle() {
  const theme = document.documentElement.dataset.theme;
  const isDark = theme ? theme === 'dark' : systemTheme.matches;
  const label = `Switch to ${isDark ? 'light' : 'dark'} mode`;
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.setAttribute('aria-label', label);
  themeToggle.setAttribute('title', label);
  themeToggle.setAttribute('data-icon', isDark ? 'sun' : 'moon');
}

updateThemeToggle();
systemTheme.addEventListener('change', updateThemeToggle);
themeToggle.addEventListener('click', () => {
  const theme = themeToggle.getAttribute('aria-pressed') === 'true' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Keep the selected theme for this page even if storage is unavailable.
  }
  updateThemeToggle();
});

function message(text, state = '') {
  status.textContent = text;
  status.dataset.state = state;
}

function revealAuthPanel() {
  if (privateVisibilitySelected()) $('auth-panel').hidden = false;
}

function privateVisibilitySelected() {
  return document.querySelector('input[name="visibility"]:checked').value === 'private';
}

function selectPrivateVisibility() {
  const privateOption = document.querySelector('input[name="visibility"][value="private"]');
  privateOption.checked = true;
  privateOption.dispatchEvent(new Event('change'));
}

function parsed() {
  try {
    return JSON.parse(editor.value);
  } catch (error) {
    const source = editor.value;
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
    editor.focus();
    editor.setSelectionRange(position, Math.min(position + 1, source.length));
    throw new Error(`Invalid JSON at line ${line}, column ${column}: ${error.message}`);
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function action(name, callback) {
  $(name).addEventListener('click', async () => {
    try { await callback(); } catch (error) { message(error.message, 'error'); }
  });
}

function headers(secretKey = key.value.trim()) {
  return { 'Content-Type': 'application/json', 'X-Secret-Key': secretKey };
}

function showGeneratedKey(secretKey) {
  key.value = secretKey;
  generatedKey = secretKey;
  generatedKeyCopied = false;
  copiedKeyValue = '';
  key.type = 'password';
  $('toggle-key').setAttribute('aria-label', 'Show secret key');
  $('toggle-key').setAttribute('title', 'Show secret key');
  $('toggle-key').setAttribute('aria-pressed', 'false');
  $('key-copy-state').textContent = 'Not copied yet. Copy this key before refreshing the page.';
  revealAuthPanel();
  $('key-help-text').hidden = false;
  $('key-help').setAttribute('aria-expanded', 'true');
}

async function sendApiRequest(method, target, body, secretKey = key.value.trim()) {
  const options = { method, headers: headers(secretKey) };
  if (body !== undefined) options.body = body;
  const result = await fetch(target, options);
  const text = await result.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  const path = new URL(target, window.location.origin).pathname;
  let displayValue = value;
  if (method === 'POST' && path === '/api/accounts' && value && value.secretKey) {
    displayValue = { secretKey: '[hidden; placed in Secret key field]' };
  } else if (method === 'POST' && path === '/api/bins' && value && value.id) {
    displayValue = { ...value, id: '[hidden; use the Bin ID reveal or copy controls]' };
  }
  responseOutput.textContent = `${result.status} ${result.statusText}\n${typeof displayValue === 'string' ? displayValue : JSON.stringify(displayValue, null, 2)}`;
  $('api-panel').open = true;
  $('api-results-panel').hidden = false;
  if (!result.ok) {
    if (result.status === 401) revealAuthPanel();
    const error = new Error(value && value.error ? value.error : `Request failed (${result.status})`);
    error.status = result.status;
    throw error;
  }
  return value;
}

function apiTarget() {
  const input = apiUrl.value.trim();
  const endpoint = /^[a-f0-9]{32}$/.test(input) ? `/api/bins/${input}` : input;
  const target = new URL(endpoint, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) {
    throw new Error('Use an endpoint on this site under /api/');
  }
  return target;
}

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

function rememberSavedBin(id, visibility) {
  savedBins = [{ id, visibility }, ...savedBins.filter(entry => entry.id !== id)];
  const persisted = persistSavedBins();
  renderSavedBins();
  return persisted;
}

function forgetSavedBin(id) {
  savedBins = savedBins.filter(entry => entry.id !== id);
  const persisted = persistSavedBins();
  renderSavedBins();
  return persisted;
}

function forgetExpiredBin(entry) {
  forgetSavedBin(entry.id);
  if (currentSavedBinId === entry.id) {
    currentSavedBinId = '';
    $('saved-bin-field').hidden = true;
    $('saved-bin-id').value = '';
  }
  message('This bin expired after 30 days without activity and was removed from this browser list.');
}

function renderSavedBins() {
  if (!document.createElement || !document.querySelector) return;
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
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.textContent = 'Use';
    useButton.addEventListener('click', () => {
      useSavedBin(entry).catch(error => message(error.message, 'error'));
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      deleteSavedBin(entry).catch(error => message(error.message, 'error'));
    });
    actions.append(useButton, deleteButton);
    item.append(label, actions);
    list.append(item);
  }
}

async function useSavedBin(entry) {
  if (entry.visibility === 'private' && !key.value.trim()) {
    selectPrivateVisibility();
    throw new Error('This private bin needs its owner key. Enter it in Authentication, then choose Use again.');
  }
  let value;
  try {
    value = await request(`/api/bins/${entry.id}`, { headers: headers() });
  } catch (error) {
    if (error.status === 404) {
      forgetExpiredBin(entry);
      return;
    }
    throw error;
  }
  editor.value = JSON.stringify(value, null, 2);
  storeEditorDraft(true);
  currentSavedBinId = entry.id;
  showSavedBinId(entry.id);
  document.querySelector(`input[name="visibility"][value="${entry.visibility}"]`).checked = true;
  $('storage-panel').open = true;
  editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
  editor.focus();
  message(`${entry.visibility === 'private' ? 'Private' : 'Public'} bin loaded into the editor`);
}

async function deleteSavedBin(entry) {
  if (entry.visibility === 'private' && !key.value.trim()) {
    selectPrivateVisibility();
    throw new Error('Enter the owner key in Authentication to delete this private bin.');
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
  if (currentSavedBinId === entry.id) {
    currentSavedBinId = '';
    $('saved-bin-field').hidden = true;
    $('saved-bin-id').value = '';
  }
  message(persisted ? 'Bin deleted from storage and this browser' : 'Bin deleted from storage; browser list could not be updated');
}

function renderLiveLogs() {
  const filter = $('log-bin-filter').value.trim().toLowerCase();
  const rows = $('log-rows');
  rows.replaceChildren();
  const visibleEvents = liveLogEvents.filter(event =>
    Date.parse(event.timestamp) >= liveLogClearedAt &&
    (!filter || (event.binId || '').toLowerCase().includes(filter))
  );
  for (const event of visibleEvents) {
    const row = document.createElement('tr');
    const time = new Date(event.timestamp).toLocaleTimeString();
    const values = [time, event.method, event.endpoint, String(event.status), `${event.durationMs} ms`];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const binCell = document.createElement('td');
    binCell.textContent = event.binId || '-';
    row.append(binCell);
    rows.append(row);
  }
  const scrollContainer = $('log-scroll-container');
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

function addLiveLogEvent(event) {
  if (Date.parse(event.timestamp) < liveLogClearedAt) return;
  liveLogEvents.push(event);
  if (liveLogEvents.length > 200) liveLogEvents.shift();
  renderLiveLogs();
}

async function connectLiveLogs() {
  if (liveLogController) return;
  const controller = new AbortController();
  liveLogController = controller;
  liveLogStartedAt = Date.now();
  liveLogLastResponseAt = liveLogStartedAt;
  liveLogLastActivityAt = liveLogStartedAt;
  liveLogStopReason = 'Disconnected';
  $('start-logs').disabled = true;
  $('stop-logs').disabled = false;
  $('logs-status').textContent = 'Connecting...';
  liveLogEvents.length = 0;
  renderLiveLogs();
  updateLiveLogTimer();
  liveLogInterval = setInterval(updateLiveLogTimer, 1000);
  try {
    const response = await fetch('/api/live-logs', {
      signal: controller.signal
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || `Log connection failed (${response.status})`);
    }
    $('logs-status').textContent = 'Connected';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      liveLogLastResponseAt = Date.now();
      pending += decoder.decode(value, { stream: true });
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const stoppedEvent = frame.split('\n').some(line => line === 'event: stopped');
        const data = frame.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (data) {
          const event = JSON.parse(data);
          if (stoppedEvent) {
            liveLogStopReason = event.reason === 'inactive'
              ? 'Stopped after 5 minutes without API activity'
              : '10-minute viewing period ended';
            controller.abort();
            break;
          }
          liveLogLastActivityAt = Date.now();
          addLiveLogEvent(event);
        }
        boundary = pending.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) liveLogStopReason = error.message;
  } finally {
    clearInterval(liveLogInterval);
    if (liveLogController === controller) {
      liveLogController = null;
      $('start-logs').disabled = false;
      $('stop-logs').disabled = true;
      $('logs-timer').textContent = liveLogStopReason === 'Stopped by you' ? '10:00 ready' : 'Inactive';
      $('logs-status').textContent = liveLogStopReason;
    }
  }
}

function updateLiveLogTimer() {
  if (!liveLogController) return;
  const now = Date.now();
  const remaining = liveLogSessionMs - (now - liveLogStartedAt);
  if (remaining <= 0) {
    liveLogStopReason = '10-minute viewing period ended';
    liveLogController.abort();
    return;
  }
  if (now - liveLogLastActivityAt >= liveLogIdleMs) {
    liveLogStopReason = 'Stopped after 5 minutes without API activity';
    liveLogController.abort();
    return;
  }
  if (now - liveLogLastResponseAt >= liveLogIdleMs) {
    liveLogStopReason = 'Stopped after 5 minutes without a server response';
    liveLogController.abort();
    return;
  }
  const seconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  $('logs-timer').textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')} remaining`;
}

$('upload').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) return message('File exceeds the 1 MB editor upload limit');
  try {
    editor.value = await file.text();
    storeEditorDraft();
    message('File loaded');
  } catch {
    message('Could not read the file');
  }
});

action('validate', () => { parsed(); message('Valid JSON', 'success'); });
action('format', () => { editor.value = JSON.stringify(parsed(), null, 2); storeEditorDraft(); message('JSON formatted'); });
action('compact', () => { editor.value = JSON.stringify(parsed()); storeEditorDraft(); message('JSON compacted'); });
action('repair', async () => {
  const result = await request('/api/repair', { method: 'POST', body: editor.value });
  editor.value = result.json;
  storeEditorDraft();
  message('JSON repaired and formatted');
});
action('download', () => {
  const blob = new Blob([JSON.stringify(parsed(), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bin.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message('JSON downloaded');
});
action('generate', async () => {
  if (key.value && !confirm('Generating a new key does not recover the old key. Continue?')) return;
  const result = await request('/api/accounts', { method: 'POST' });
  showGeneratedKey(result.secretKey);
  message('Account created. Copy the hidden key and save it securely.');
});
action('toggle-key', () => {
  key.type = key.type === 'password' ? 'text' : 'password';
  const label = key.type === 'password' ? 'Show secret key' : 'Hide secret key';
  $('toggle-key').setAttribute('aria-label', label);
  $('toggle-key').setAttribute('title', label);
  $('toggle-key').setAttribute('aria-pressed', String(key.type === 'text'));
});
action('copy-key', async () => {
  if (!key.value) throw new Error('Generate or enter a secret key first');
  await navigator.clipboard.writeText(key.value);
  copiedKeyValue = key.value.trim();
  if (key.value === generatedKey) generatedKeyCopied = true;
  $('key-copy-state').textContent = 'Copied successfully in this tab. Save it in a password manager.';
  message('Secret key copied. Store it securely.');
});
action('copy-bin-id', async () => {
  if (!$('saved-bin-id').value) throw new Error('Save a bin first');
  await navigator.clipboard.writeText($('saved-bin-id').value);
  message('Bin ID copied');
});
action('toggle-bin-id', () => {
  const binId = $('saved-bin-id');
  binId.type = binId.type === 'password' ? 'text' : 'password';
  const label = binId.type === 'password' ? 'Show bin ID' : 'Hide bin ID';
  $('toggle-bin-id').setAttribute('aria-label', label);
  $('toggle-bin-id').setAttribute('title', label);
  $('toggle-bin-id').setAttribute('aria-pressed', String(binId.type === 'text'));
});
$('key-help').addEventListener('click', () => {
  const help = $('key-help-text');
  help.hidden = !help.hidden;
  $('key-help').setAttribute('aria-expanded', String(!help.hidden));
});
action('send-request', async () => {
  const method = apiMethod.value;
  const target = apiTarget();
  if (method === 'DELETE' && !confirm('Delete this bin? The owner key or its creating browser cookie is required.')) return;
  const value = await sendApiRequest(method, target.pathname + target.search,
    ['POST', 'PUT', 'PATCH'].includes(method) ? editor.value : undefined,
    apiKeyHeader.value.trim() || key.value.trim());
  if (method === 'POST' && target.pathname === '/api/bins' && value.id) {
    currentSavedBinId = value.id;
    showSavedBinId(value.id);
    rememberSavedBin(value.id, value.visibility || 'public');
  }
  const updatedBin = /^\/api\/bins\/([a-f0-9]{32})$/.exec(target.pathname);
  if (updatedBin && ['PUT', 'PATCH'].includes(method)) {
    currentSavedBinId = updatedBin[1];
    showSavedBinId(updatedBin[1]);
    const savedEntry = savedBins.find(entry => entry.id === updatedBin[1]);
    if (savedEntry) rememberSavedBin(updatedBin[1], savedEntry.visibility);
  }
  if (method === 'DELETE' && updatedBin) {
    forgetSavedBin(updatedBin[1]);
    if (currentSavedBinId === updatedBin[1]) {
      currentSavedBinId = '';
      $('saved-bin-field').hidden = true;
      $('saved-bin-id').value = '';
    }
  }
  if (method === 'POST' && target.pathname === '/api/accounts' && value.secretKey) {
    showGeneratedKey(value.secretKey);
  }
  if (['POST', 'PUT', 'PATCH'].includes(method) && target.pathname.startsWith('/api/bins')) {
    storeEditorDraft(true);
  }
  message('Request completed');
});
action('save-bin', async () => {
  const visibility = document.querySelector('input[name="visibility"]:checked').value;
  const parsedValue = parsed();
  editor.value = JSON.stringify(parsedValue, null, 2);
  storeEditorDraft();
  if (visibility === 'private' && !key.value.trim()) {
    const account = await request('/api/accounts', { method: 'POST' });
    showGeneratedKey(account.secretKey);
    $('key-copy-state').textContent = 'A key was generated. Copy and save it now; the bin will not be created until you press Save again.';
  }
  if (visibility === 'private' && copiedKeyValue !== key.value.trim()) {
    throw new Error('Private bin not saved. Copy the owner key with the Copy button, then press Save bin again.');
  }
  if (visibility === 'private' && !key.value.trim()) {
    revealAuthPanel();
    throw new Error('Private bins require the owner key. Enter or generate one in Authentication.');
  }
  const savedBinId = currentSavedBinId;
  const method = savedBinId ? 'PUT' : 'POST';
  const target = savedBinId ? `/api/bins/${savedBinId}` : `/api/bins?visibility=${visibility}`;
  const body = JSON.stringify(parsedValue);
  const value = await sendApiRequest(method, target, body);
  storeEditorDraft(true);
  const id = method === 'POST' ? value.id : savedBinId;
  const savedEntry = savedBins.find(entry => entry.id === id);
  const persisted = rememberSavedBin(id, method === 'POST' ? value.visibility : savedEntry?.visibility || visibility);
  currentSavedBinId = id;
  showSavedBinId(id);
  const copyKeyReminder = generatedKey && key.value === generatedKey && !generatedKeyCopied
    ? ' Copy the generated owner key now; it cannot be recovered.'
    : '';
  message(persisted
    ? (method === 'POST' ? 'Bin saved and added to this browser’s list.' : 'Bin updated.') + copyKeyReminder
    : 'Bin saved remotely, but browser storage is unavailable; copy its ID to keep track of it.');
});
$('new-bin').addEventListener('click', () => {
  currentSavedBinId = '';
  $('saved-bin-field').hidden = true;
  $('saved-bin-id').value = '';
  message('Ready to create a new bin');
});
$('start-logs').addEventListener('click', () => {
  connectLiveLogs().catch(error => { $('logs-status').textContent = error.message; });
});
$('stop-logs').addEventListener('click', () => {
  liveLogStopReason = 'Stopped by you';
  $('logs-timer').textContent = '10:00 ready';
  if (liveLogController) liveLogController.abort();
});
$('clear-logs').addEventListener('click', () => {
  liveLogClearedAt = Date.now();
  liveLogEvents.length = 0;
  renderLiveLogs();
});
$('log-bin-filter').addEventListener('input', renderLiveLogs);
$('copyright-year').textContent = String(new Date().getFullYear());
renderSavedBins();
if (document.querySelectorAll) {
  document.querySelectorAll('input[name="visibility"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isPrivate = document.querySelector('input[name="visibility"]:checked').value === 'private';
      $('visibility-note').textContent = isPrivate
        ? 'Private bins require the owner key to save, read, edit, and delete. Enter or generate the key in Authentication.'
        : 'Public bins can be created and read without entering a key. This browser receives an HttpOnly owner cookie for updates and deletes; other clients need the owner key.';
      $('auth-panel').hidden = !isPrivate;
      if (isPrivate) $('storage-panel').open = true;
    });
  });
  document.querySelectorAll('.endpoint-use').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      apiMethod.value = link.dataset.method;
      apiUrl.value = link.dataset.endpoint;
      const endpoint = new URL(link.dataset.endpoint, window.location.origin);
      if (link.dataset.method === 'POST' && endpoint.pathname === '/api/bins') {
        currentSavedBinId = '';
        $('saved-bin-field').hidden = true;
        $('saved-bin-id').value = '';
      }
      $('api-panel').open = true;
      $('api-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      apiUrl.focus();
    });
  });
}
