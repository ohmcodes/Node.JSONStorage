import { $ } from './core.js';

const liveLogSessionMs = 10 * 60 * 1000;
const liveLogIdleMs = 5 * 60 * 1000;
let liveLogController = null;
const liveLogEvents = [];
let liveLogClearedAt = 0;
let liveLogInterval = null;
let liveLogStopReason = 'Disconnected';
let liveLogStartedAt = 0;
let liveLogLastResponseAt = 0;
let liveLogLastActivityAt = 0;

export function renderLiveLogs() {
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

export async function connectLiveLogs() {
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
    const response = await fetch('/api/live-logs', { signal: controller.signal });
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

export function stopLiveLogs() {
  liveLogStopReason = 'Stopped by you';
  $('logs-timer').textContent = '10:00 ready';
  if (liveLogController) liveLogController.abort();
}

export function clearLiveLogs() {
  liveLogClearedAt = Date.now();
  liveLogEvents.length = 0;
  renderLiveLogs();
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
