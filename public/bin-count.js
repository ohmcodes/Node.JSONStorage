import { request } from './api.js';

let latestRequest = 0;

export async function refreshBinCount() {
  const sequence = ++latestRequest;
  const output = document.getElementById('bin-count');
  try {
    const result = await request('/api/bin-count', { cache: 'no-store' });
    if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error('Invalid bin count');
    if (sequence === latestRequest) output.textContent = `Current bins on server: ${result.count.toLocaleString()}`;
  } catch {
    if (sequence === latestRequest) output.textContent = 'Current bins on server: unavailable';
  }
}
