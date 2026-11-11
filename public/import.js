// Import WakaTime history in the browser: download the export through the Worker,
// count time with the same code the server uses, and upload compact daily totals.

import { addDays, dayOf, dayStart, summarizeDay } from '/lib/core.js';
import { isModelName, parseUserAgent } from '/lib/useragent.js';

const OS_NAMES = { mac: 'macOS', macos: 'macOS', darwin: 'macOS', windows: 'Windows', linux: 'Linux' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// WakaTime's own labels can be off (e.g. editor "Opus" for Claude Code's AI activity),
// so prefer what Waqt's parser reads from the raw user agent.
const uaCache = new Map();
function agent(ua) {
  if (!uaCache.has(ua.value)) {
    const parsed = parseUserAgent(ua.value || '');
    const editor = parsed.editor || (isModelName(ua.editor) ? '' : ua.editor || '');
    const os = parsed.os || OS_NAMES[(ua.os || '').toLowerCase()] || ua.os || '';
    const model = parsed.model || ua.ai_model || (isModelName(ua.editor) ? ua.editor : '');
    uaCache.set(ua.value, { editor, os, model });
  }
  return uaCache.get(ua.value);
}

function toBeat(h, lookups) {
  const a = agent(lookups.user_agents[h.user_agent_id] || {});
  return {
    time: Number(h.time),
    project: h.project || '',
    language: h.language || '',
    editor: a.editor,
    os: a.os,
    machine: lookups.machines[h.machine_name_id] || '',
    category: (h.category || 'coding').toLowerCase(),
    ai_model: a.model,
    ai_session: h.ai_session || '',
    ai_input_tokens: int(h.ai_input_tokens),
    ai_output_tokens: int(h.ai_output_tokens),
    ai_cached_tokens: int(h.ai_cached_input_tokens),
    ai_prompt_length: int(h.ai_prompt_length),
    ai_line_changes: int(h.ai_line_changes),
    human_line_changes: int(h.human_line_changes),
    entity: h.entity || '',
    type: h.type || 'file',
    branch: h.branch || '',
  };
}

/** Fill "<<LAST_LANGUAGE>>" with the language last used in the same project. */
function resolveLastLanguage(beats) {
  const last = new Map();
  for (const b of beats) {
    if (b.language === '<<LAST_LANGUAGE>>') b.language = last.get(b.project) || '';
    else if (b.language) last.set(b.project, b.language);
  }
}

async function readWithProgress(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/**
 * @param {{ api: Function, headers?: Record<string, string>, file?: File, onStatus: (msg: string, pct?: number) => void }} opts
 */
export async function runImport({ api, headers = {}, file, onStatus }) {
  const status = (await api('/users/current/import/status')).data;
  let text;
  if (file) {
    onStatus(`Reading ${file.name}…`);
    text = await file.text();
  } else {
    onStatus('Asking WakaTime to prepare your export…', 2);
    for (let tries = 0; ; tries++) {
      const d = (await api('/users/current/import/wakatime/dump', { method: 'POST' })).data;
      if (d.ready) break;
      if (d.failed) throw new Error('WakaTime could not prepare the export. Try again later.');
      if (tries > 360) throw new Error('WakaTime is taking too long. Try again later.');
      onStatus(`WakaTime is preparing your export… ${d.percent || 0}%`, 2 + (d.percent || 0) * 0.28);
      await sleep(5000);
    }
    onStatus('Downloading your export…', 30);
    const res = await fetch('/api/v1/users/current/import/wakatime/download', { headers, credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    text = await readWithProgress(res, (got, total) => {
      const mb = (got / 1048576).toFixed(1);
      onStatus(`Downloading your export… ${mb} MB${total ? ` of ${(total / 1048576).toFixed(1)} MB` : ''}`, 30 + (total ? (got / total) * 30 : 0));
    });
  }

  onStatus('Reading the export…', 62);
  let dump;
  try {
    dump = JSON.parse(text);
  } catch {
    throw new Error('That file is not a WakaTime heartbeats export (JSON).');
  }
  text = null;
  const lookups = (await api('/users/current/import/wakatime/lookups')).data;

  const ownSince = status.own_since || Infinity;
  const beats = [];
  for (const d of dump.days || []) for (const h of d.heartbeats || []) {
    const b = toBeat(h, lookups);
    if (Number.isFinite(b.time) && b.time < ownSince) beats.push(b);
  }
  dump = null;
  if (!beats.length) throw new Error('Nothing to import: the export has no activity from before Waqt started.');
  beats.sort((a, b) => a.time - b.time);
  resolveLastLanguage(beats);

  onStatus(`Counting time for ${beats.length.toLocaleString()} heartbeats…`, 66);
  await sleep(30);
  const tz = status.timezone;
  const timeout = status.timeout_minutes * 60;
  const days = [];
  let i = 0;
  while (i < beats.length) {
    const day = dayOf(beats[i].time, tz);
    const start = dayStart(day, tz);
    const end = Math.min(dayStart(addDays(day, 1), tz), ownSince);
    let j = i;
    while (j < beats.length && beats[j].time < end) j++;
    // Include the next heartbeat so the day's last session is counted up to midnight.
    const slice = beats.slice(i, Math.min(j + 1, beats.length));
    const sum = summarizeDay(slice, start, end, timeout);
    if (sum.rows.length) days.push({ day, ...sum });
    i = j;
  }

  const CHUNK = 31;
  let stored = 0;
  for (let k = 0; k < days.length; k += CHUNK) {
    const part = days.slice(k, k + CHUNK);
    const r = await api('/users/current/import/days', { method: 'POST', body: JSON.stringify({ days: part }) });
    stored += r.data.stored;
    onStatus(`Saving… ${Math.min(k + CHUNK, days.length)} of ${days.length} days`, 70 + ((k + CHUNK) / days.length) * 29);
  }
  await api('/users/current/import/done', { method: 'POST' });
  const seconds = days.reduce((a, d) => a + d.rows.reduce((x, r) => x + r[6], 0), 0);
  return { days: stored, seconds, first: days[0]?.day, last: days[days.length - 1]?.day };
}
