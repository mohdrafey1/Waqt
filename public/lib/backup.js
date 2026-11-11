// Make and restore Waqt backups. Shared by the dashboard and scripts/backup.mjs.
// `api(path, opts)` calls the Waqt API (paths start with /users/current) and
// returns the parsed JSON body.

import { addDays } from './core.js';

export const BACKUP_FORMAT = 'waqt-backup';
const DAYS_PER_REQUEST = 62;
const ROWS_PER_RESTORE = 5000;

/**
 * @param {(path: string, opts?: any) => Promise<any>} api
 * @param {(msg: string, pct?: number) => void} [onStatus]
 */
export async function createBackup(api, onStatus = () => {}) {
  const meta = (await api('/users/current/backup')).data;
  const backup = {
    format: meta.format,
    version: meta.version,
    created: meta.created,
    timezone: meta.timezone,
    first_day: meta.first_day,
    last_day: meta.last_day,
    settings: meta.settings,
    tables: Object.fromEntries(Object.entries(meta.tables).map(([name, t]) => [name, { columns: t.columns, rows: [] }])),
  };
  if (!meta.first_day) return backup;
  const step = Math.min(DAYS_PER_REQUEST, meta.max_days_per_request || DAYS_PER_REQUEST);
  const span = daysBetween(meta.first_day, meta.last_day) + 1;
  for (let from = meta.first_day; from <= meta.last_day; from = addDays(from, step)) {
    const to = minDay(addDays(from, step - 1), meta.last_day);
    const page = (await api(`/users/current/backup/days?from=${from}&to=${to}`)).data;
    for (const [name, t] of Object.entries(page.tables)) {
      if (!backup.tables[name]) backup.tables[name] = { columns: t.columns, rows: [] };
      for (const r of t.rows) backup.tables[name].rows.push(r);
    }
    onStatus(`Reading ${from.slice(0, 7)}…`, Math.min(99, ((daysBetween(meta.first_day, to) + 1) / span) * 100));
  }
  return backup;
}

/**
 * @param {(path: string, opts?: any) => Promise<any>} api
 * @param {any} backup  parsed backup file
 * @param {(msg: string, pct?: number) => void} [onStatus]
 */
export async function restoreBackup(api, backup, onStatus = () => {}) {
  if (!backup || backup.format !== BACKUP_FORMAT || !backup.tables) throw new Error('That file is not a Waqt backup.');
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  onStatus('Restoring settings…', 1);
  await post('/users/current/backup/restore/settings', { settings: backup.settings || {} });

  // Group rows by day: the server replaces whole days, so a day must arrive in one request.
  /** @type {Map<string, Record<string, any[][]>>} */
  const byDay = new Map();
  for (const [name, t] of Object.entries(backup.tables)) {
    const dayAt = t.columns.indexOf('day');
    if (dayAt < 0) continue;
    for (const row of t.rows) {
      const day = row[dayAt];
      let d = byDay.get(day);
      if (!d) byDay.set(day, (d = {}));
      (d[name] ||= []).push(row);
    }
  }
  const days = [...byDay.keys()].sort();
  let done = 0;
  let restored = 0;
  let batch = [];
  let rows = 0;
  const send = async () => {
    if (!batch.length) return;
    /** @type {Record<string, {columns: string[], rows: any[][]}>} */
    const tables = {};
    for (const day of batch) {
      for (const [name, list] of Object.entries(byDay.get(day))) {
        if (!tables[name]) tables[name] = { columns: backup.tables[name].columns, rows: [] };
        for (const r of list) tables[name].rows.push(r);
      }
    }
    const r = (await post('/users/current/backup/restore', { tables })).data;
    restored += r.restored;
    done += batch.length;
    onStatus(`Restoring… ${done} of ${days.length} days`, 2 + (done / days.length) * 96);
    batch = [];
    rows = 0;
  };
  for (const day of days) {
    const n = Object.values(byDay.get(day)).reduce((a, l) => a + l.length, 0);
    if (rows && rows + n > ROWS_PER_RESTORE) await send();
    batch.push(day);
    rows += n;
  }
  await send();
  await post('/users/current/backup/restore/done', {});
  return { days: days.length, rows: restored, first: days[0], last: days[days.length - 1] };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
const minDay = (a, b) => (a < b ? a : b);
