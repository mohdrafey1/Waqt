// Backups: everything Waqt shows comes from the daily tables, so a backup is
// those tables plus your settings (secrets left out). Raw heartbeats are not
// included: they are only kept for a while anyway and the daily totals hold
// everything the dashboard, cards and API need.
//
// GET  /users/current/backup                 what's in the database + settings
// GET  /users/current/backup/days?from&to    rows of every daily table, ≤ 92 days
// POST /users/current/backup/restore         { tables } as returned by /days
// POST /users/current/backup/restore/settings { settings }
// POST /users/current/backup/restore/done    protect restored days, clear caches

import { Hono } from 'hono';
import { type AppEnv, requireAuth } from '../http';
import { DEFAULTS, saveSettings, tzOf } from '../settings';
import { clearCache } from '../stats';
import { addDays, dayOf, dayStart, isDay, todayIn } from '../time';

export const BACKUP_FORMAT = 'waqt-backup';
export const BACKUP_VERSION = 1;
const MAX_DAYS = 92;
const MAX_ROWS = 20000;

type Col = { name: string; kind: 'text' | 'num' | 'int' };
const t = (name: string): Col => ({ name, kind: 'text' });
const n = (name: string): Col => ({ name, kind: 'num' });
const i = (name: string): Col => ({ name, kind: 'int' });

export const TABLES: Record<string, Col[]> = {
  daily_summaries: [t('day'), t('source'), t('project'), t('language'), t('editor'), t('os'), t('machine'), t('category'), n('seconds'), i('ai_lines'), i('human_lines')],
  daily_hours: [t('day'), t('source'), i('hour'), n('seconds')],
  daily_ai: [t('day'), t('source'), t('model'), n('seconds'), i('sessions'), i('prompts'), i('input_tokens'), i('output_tokens'), i('cached_tokens'), i('ai_lines')],
  daily_files: [t('day'), t('source'), t('project'), t('branch'), t('entity'), n('seconds')],
};

// Settings that describe this database rather than you, or that are secrets.
const NOT_BACKED_UP = new Set([
  'needs_rebuild',
  'last_prune_day',
  'raw_since',
  'parser_version',
  'forward_error',
  'report_discord',
  'report_telegram_token',
  'dashboard_password',
  'latest_version',
  'latest_checked',
  'last_goal_nudge',
  'last_week_goal_nudge',
  'last_streak_nudge',
  'import_summary',
]);

export const backup = new Hono<AppEnv>();
backup.use('*', requireAuth);

backup.get('/', async (c) => {
  const s = c.get('settings');
  // MIN and MAX of the first key column are index lookups: two rows read, however big the table.
  const [first_, last_, rows] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT MIN(day) AS first FROM daily_summaries'),
    c.env.DB.prepare('SELECT MAX(day) AS last FROM daily_summaries'),
    c.env.DB.prepare('SELECT key, value FROM settings'),
  ]);
  const settings: Record<string, string> = {};
  for (const r of rows.results as { key: string; value: string }[]) if (!NOT_BACKED_UP.has(r.key)) settings[r.key] = r.value;
  const first = (first_.results[0] as { first: string | null }).first;
  const last = (last_.results[0] as { last: string | null }).last;
  return c.json({
    data: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      created: new Date().toISOString(),
      timezone: tzOf(s),
      first_day: first,
      last_day: last,
      max_days_per_request: MAX_DAYS,
      settings,
      tables: Object.fromEntries(Object.entries(TABLES).map(([k, cols]) => [k, { columns: cols.map((x) => x.name) }])),
    },
  });
});

backup.get('/days', async (c) => {
  const from = c.req.query('from') || '';
  const to = c.req.query('to') || '';
  if (!isDay(from) || !isDay(to) || from > to) return c.json({ error: 'from and to must be YYYY-MM-DD, from first' }, 400);
  if (addDays(from, MAX_DAYS - 1) < to) return c.json({ error: `At most ${MAX_DAYS} days per request` }, 400);
  const names = Object.keys(TABLES);
  const results = await c.env.DB.batch(
    names.map((name) =>
      c.env.DB.prepare(`SELECT ${TABLES[name].map((x) => x.name).join(', ')} FROM ${name} WHERE day BETWEEN ?1 AND ?2 ORDER BY day`)
        .bind(from, to),
    ),
  );
  const tables: Record<string, { columns: string[]; rows: unknown[][] }> = {};
  names.forEach((name, k) => {
    const cols = TABLES[name].map((x) => x.name);
    tables[name] = { columns: cols, rows: (results[k].results as Record<string, unknown>[]).map((r) => cols.map((col) => r[col])) };
  });
  return c.json({ data: { from, to, tables } });
});

function clean(col: Col, v: unknown): string | number | null {
  if (col.kind === 'text') {
    if (typeof v !== 'string') return null;
    if (col.name === 'day') return isDay(v) ? v : null;
    if (col.name === 'source') return v === 'live' || v === 'import' ? v : null;
    return v.slice(0, 300);
  }
  const num = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(num) || num < 0) return null;
  return col.kind === 'int' ? Math.trunc(num) : num;
}

backup.post('/restore', async (c) => {
  let body: { tables?: Record<string, { columns?: unknown; rows?: unknown }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const incoming = body.tables && typeof body.tables === 'object' ? body.tables : {};
  const prepared: { name: string; rows: (string | number)[][] }[] = [];
  const keys = new Set<string>(); // "day|source" pairs being replaced
  let total = 0;
  let skipped = 0;
  for (const [name, cols] of Object.entries(TABLES)) {
    const tbl = incoming[name];
    if (!tbl) continue;
    const columns = Array.isArray(tbl.columns) ? (tbl.columns as unknown[]).map(String) : [];
    const rows = Array.isArray(tbl.rows) ? (tbl.rows as unknown[]) : [];
    // Map the file's columns to ours, so older or newer backups still restore.
    const index = cols.map((col) => columns.indexOf(col.name));
    if (index[0] < 0 || index[1] < 0) return c.json({ error: `${name}: missing day or source column` }, 400);
    total += rows.length;
    if (total > MAX_ROWS) return c.json({ error: `At most ${MAX_ROWS} rows per request` }, 400);
    const out: (string | number)[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) {
        skipped++;
        continue;
      }
      const vals = cols.map((col, k) => (index[k] < 0 ? (col.kind === 'text' ? '' : 0) : clean(col, row[index[k]])));
      if (vals.some((v) => v === null)) {
        skipped++;
        continue;
      }
      out.push(vals as (string | number)[]);
      keys.add(`${vals[0]}|${vals[1]}`);
    }
    prepared.push({ name, rows: out });
  }
  if (!keys.size) return c.json({ data: { restored: 0, days: 0, skipped } });

  const keyList = JSON.stringify([...keys]);
  const statements: D1PreparedStatement[] = Object.keys(TABLES).map((name) =>
    c.env.DB.prepare(`DELETE FROM ${name} WHERE day || '|' || source IN (SELECT value FROM json_each(?1))`).bind(keyList),
  );
  for (const p of prepared) {
    if (!p.rows.length) continue;
    const cols = TABLES[p.name];
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO ${p.name} (${cols.map((x) => x.name).join(', ')})
         SELECT ${cols.map((_, k) => `json_extract(value, '$[${k}]')`).join(', ')} FROM json_each(?1)`,
      ).bind(JSON.stringify(p.rows)),
    );
  }
  await c.env.DB.batch(statements);
  const days = new Set([...keys].map((k) => k.split('|')[0]));
  return c.json({ data: { restored: prepared.reduce((a, p) => a + p.rows.length, 0), days: days.size, skipped } });
});

backup.post('/restore/settings', async (c) => {
  const s = c.get('settings');
  let body: { settings?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const incoming = body.settings && typeof body.settings === 'object' ? body.settings : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in DEFAULTS) || NOT_BACKED_UP.has(k) || typeof v !== 'string' || v.length > 20000) continue;
    out[k] = v;
  }
  // Keep the earliest "first heartbeat", so a later WakaTime import never overlaps restored days.
  if (out.first_heartbeat) {
    const a = Number(out.first_heartbeat) || 0;
    const b = s.first_heartbeat;
    out.first_heartbeat = String(a && b ? Math.min(a, b) : a || b);
  }
  if (out.timezone && out.timezone !== s.timezone) out.needs_rebuild = '1';
  if (Object.keys(out).length) await saveSettings(c.env.DB, out);
  return c.json({ data: { restored: Object.keys(out).filter((k) => k !== 'needs_rebuild') } });
});

// Restored days have no raw heartbeats here, so they must never be rebuilt from raw
// (that would wipe them). Raw data in this database starts at its first heartbeat.
backup.post('/restore/done', async (c) => {
  const s = c.get('settings');
  const tz = tzOf(s);
  const first = await c.env.DB.prepare('SELECT MIN(time) AS t FROM heartbeats').first<{ t: number | null }>();
  const firstRawDay = first?.t != null ? dayOf(first.t, tz) : todayIn(tz);
  const protectUntil = dayStart(firstRawDay, tz);
  await saveSettings(c.env.DB, { import_summary: '', ...(protectUntil > s.raw_since ? { raw_since: String(protectUntil) } : {}) });
  await clearCache(c.env);
  return c.json({ data: { ok: true, raw_since: Math.max(protectUntil, s.raw_since) } });
});
