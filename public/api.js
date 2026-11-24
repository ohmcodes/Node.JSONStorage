import { $, revealAuthPanel, ui } from './core.js';

export async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

export function headers(secretKey = ui.key.value.trim()) {
  return { 'Content-Type': 'application/json', 'X-Secret-Key': secretKey };
}

export async function sendApiRequest(method, target, body, secretKey = ui.key.value.trim()) {
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
  ui.responseOutput.textContent = `${result.status} ${result.statusText}\n${typeof displayValue === 'string' ? displayValue : JSON.stringify(displayValue, null, 2)}`;
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

export function apiTarget() {
  const input = ui.apiUrl.value.trim();
  const endpoint = /^[a-f0-9]{32}$/.test(input) ? `/api/bins/${input}` : input;
  const target = new URL(endpoint, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) {
    throw new Error('Use an endpoint on this site under /api/');
  }
  return target;
}
