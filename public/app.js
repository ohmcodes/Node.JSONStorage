const $ = id => document.getElementById(id);
const editor = $('editor');
const status = $('status');
const key = $('key');
const id = $('id');
const themeToggle = $('theme-toggle');
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
  themeToggle.setAttribute('aria-pressed', String(theme ? theme === 'dark' : systemTheme.matches));
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

function message(text) {
  status.textContent = text;
}

function parsed() {
  try {
    return JSON.parse(editor.value);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function action(name, callback) {
  $(name).addEventListener('click', async () => {
    try { await callback(); } catch (error) { message(error.message); }
  });
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-Secret-Key': key.value.trim() };
}

function binUrl() {
  if (!/^[a-f0-9]{32}$/.test(id.value.trim())) throw new Error('Enter a valid bin ID');
  return `/api/bins/${id.value.trim()}`;
}

$('upload').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) return message('File exceeds the 1 MB editor upload limit');
  try {
    editor.value = await file.text();
    message('File loaded');
  } catch {
    message('Could not read the file');
  }
});

action('validate', () => { parsed(); message('Valid JSON'); });
action('format', () => { editor.value = JSON.stringify(parsed(), null, 2); message('JSON formatted'); });
action('compact', () => { editor.value = JSON.stringify(parsed()); message('JSON compacted'); });
action('repair', async () => {
  const result = await request('/api/repair', { method: 'POST', body: editor.value });
  editor.value = result.json;
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
  key.value = result.secretKey;
  key.type = 'text';
  $('show-key').textContent = 'Hide key';
  message('Account created. Copy and save your secret key now.');
});
action('show-key', () => {
  key.type = key.type === 'password' ? 'text' : 'password';
  $('show-key').textContent = key.type === 'password' ? 'Show key' : 'Hide key';
});
action('save', async () => {
  const result = await request(`/api/bins?visibility=${$('visibility').value}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(parsed())
  });
  id.value = result.id;
  message(`Bin saved. ID: ${result.id}`);
});
action('load', async () => {
  const value = await request(binUrl(), { headers: headers() });
  editor.value = JSON.stringify(value, null, 2);
  message('Bin loaded');
});
for (const [name, method] of [['replace', 'PUT'], ['update', 'PATCH']]) {
  action(name, async () => {
    const value = await request(binUrl(), { method, headers: headers(), body: JSON.stringify(parsed()) });
    editor.value = JSON.stringify(value, null, 2);
    message('Bin updated');
  });
}
action('delete', async () => {
  if (!confirm('Delete this bin?')) return;
  await request(binUrl(), { method: 'DELETE', headers: headers() });
  id.value = '';
  message('Bin deleted');
});
