import { Env, Settings, tzOf } from './settings';
import { summarizeDay, type Beat, type DaySummary } from '../public/lib/core.js';
import { addDays, dayStart, dayOf, todayIn } from './time';

/**
 * Rebuild one day's live totals from its raw heartbeats (see public/lib/core.js
 * for how time is counted). Imported history for the day is left alone.
 */
export async function recomputeDay(env: Env, s: Settings, day: string, markedAt: number): Promise<void> {
  const tz = tzOf(s);
  const start = dayStart(day, tz);

  // Never rebuild a day whose raw heartbeats may already be pruned: we'd lose its summary.
  if (start < s.raw_since) {
    await env.DB.prepare('DELETE FROM dirty_days WHERE day = ?1 AND marked_at <= ?2').bind(day, markedAt).run();
    return;
  }

  const end = dayStart(addDays(day, 1), tz);
  const timeout = s.timeout_minutes * 60;
  const { results } = await env.DB.prepare(
    `SELECT time, project, language, editor, os, machine, category, ai_model, ai_session,
            ai_input_tokens, ai_output_tokens, ai_cached_tokens, ai_prompt_length,
            ai_line_changes, human_line_changes, entity, type, branch
     FROM heartbeats WHERE time >= ?1 AND time < ?2 ORDER BY time`,
  )
    .bind(start, end + timeout)
    .all<Beat>();

  const sum = summarizeDay(results, start, end, timeout);
  await env.DB.batch([
    ...(await syncDaysStatements(env.DB, 'live', [{ day, sum }])),
    // Only clear the flag if no newer heartbeat re-marked the day while we worked.
    env.DB.prepare('DELETE FROM dirty_days WHERE day = ?1 AND marked_at <= ?2').bind(day, markedAt),
  ]);
}

// Key and value columns of each daily table (the key columns follow day and source
// in the primary key).
const TABLES: [table: string, keys: string[], values: string[]][] = [
  ['daily_summaries', ['project', 'language', 'editor', 'os', 'machine', 'category'], ['seconds', 'ai_lines', 'human_lines']],
  ['daily_hours', ['hour'], ['seconds']],
  ['daily_ai', ['model'], ['seconds', 'sessions', 'prompts', 'input_tokens', 'output_tokens', 'cached_tokens', 'ai_lines']],
  ['daily_files', ['project', 'branch', 'entity'], ['seconds']],
];

type DaySum = { day: string; sum: Omit<DaySummary, 'files'> & { files?: DaySummary['files'] } };
type Row = unknown[];

const keyOf = (r: Row, n: number) => r.slice(0, n + 1).map(String).join('\u0000');
const same = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? '');

/**
 * Statements that make the stored totals of `days` (from one source, 'live' or 'import')
 * match the new ones. What's stored is read first, so only rows that are new, changed or
 * gone are written: today is recalculated every few minutes while you code and imports
 * get run again, and D1's free plan counts every row written (deletes included).
 */
export async function syncDaysStatements(db: D1Database, source: string, days: DaySum[]): Promise<D1PreparedStatement[]> {
  if (!days.length) return [];
  const dayList = JSON.stringify(days.map((d) => d.day));
  const stored = await db.batch(
    TABLES.map(([table, keys, values]) =>
      db
        .prepare(`SELECT day, ${[...keys, ...values].join(', ')} FROM ${table} WHERE source = ?1 AND day IN (SELECT value FROM json_each(?2))`)
        .bind(source, dayList),
    ),
  );
  const fresh: Record<string, Row[]> = {
    daily_summaries: days.flatMap((d) => d.sum.rows.map((r) => [d.day, ...r])),
    daily_hours: days.flatMap((d) => d.sum.hours.map((r) => [d.day, ...r])),
    daily_ai: days.flatMap((d) => d.sum.ai.map((r) => [d.day, ...r])),
    daily_files: days.flatMap((d) => (d.sum.files || []).map((r) => [d.day, ...r])),
  };
  const j = (i: number) => `json_extract(value, '$[${i}]')`;
  const out: D1PreparedStatement[] = [];
  TABLES.forEach(([table, keys, values], t) => {
    const cols = ['day', ...keys, ...values];
    const old = new Map<string, Row>();
    for (const r of stored[t].results as Record<string, unknown>[]) {
      const row = cols.map((c) => r[c]);
      old.set(keyOf(row, keys.length), row);
    }
    const upserts: Row[] = [];
    const seen = new Set<string>();
    for (const row of fresh[table]) {
      const k = keyOf(row, keys.length);
      if (seen.has(k)) continue;
      seen.add(k);
      const prev = old.get(k);
      if (!prev || values.some((_, i) => !same(prev[keys.length + 1 + i], row[keys.length + 1 + i]))) upserts.push(row);
    }
    const gone = [...old.entries()].filter(([k]) => !seen.has(k)).map(([, r]) => r.slice(0, keys.length + 1));
    if (gone.length) {
      out.push(
        db
          .prepare(
            `DELETE FROM ${table} WHERE source = ?1 AND (day, ${keys.join(', ')}) IN (SELECT ${['day', ...keys].map((_, i) => j(i)).join(', ')} FROM json_each(?2))`,
          )
          .bind(source, JSON.stringify(gone)),
      );
    }
    if (upserts.length) {
      out.push(
        db
          .prepare(
            `INSERT INTO ${table} (day, source, ${cols.slice(1).join(', ')})
             SELECT ${j(0)}, ?1, ${cols.slice(1).map((_, i) => j(i + 1)).join(', ')} FROM json_each(?2) WHERE true
             ON CONFLICT(day, source, ${keys.join(', ')}) DO UPDATE SET ${values.map((v) => `${v} = excluded.${v}`).join(', ')}`,
          )
          .bind(source, JSON.stringify(upserts)),
      );
    }
  });
  return out;
}

/** Recalculate up to `max` days that changed, newest first. Returns how many were done. */
export async function flushDirty(env: Env, s: Settings, max: number, onlyDays?: string[]): Promise<number> {
  let rows: { day: string; marked_at: number }[];
  if (onlyDays && onlyDays.length) {
    ({ results: rows } = await env.DB.prepare(
      'SELECT day, marked_at FROM dirty_days WHERE day IN (SELECT value FROM json_each(?1)) ORDER BY day DESC LIMIT ?2',
    )
      .bind(JSON.stringify(onlyDays), max)
      .all());
  } else {
    ({ results: rows } = await env.DB.prepare('SELECT day, marked_at FROM dirty_days ORDER BY day DESC LIMIT ?1')
      .bind(max)
      .all());
  }
  for (const r of rows) await recomputeDay(env, s, r.day, r.marked_at);
  return rows.length;
}

export async function markDaysDirty(env: Env, days: string[]): Promise<void> {
  if (!days.length) return;
  await env.DB.prepare(
    `INSERT INTO dirty_days (day, marked_at) SELECT value, ?2 FROM json_each(?1) WHERE true
     ON CONFLICT(day) DO UPDATE SET marked_at = excluded.marked_at`,
  )
    .bind(JSON.stringify([...new Set(days)]), Date.now())
    .run();
}

/** After changing time zone or timeout: rebuild every day we still have raw data for. */
export async function markAllRawDaysDirty(env: Env, s: Settings): Promise<number> {
  const tz = tzOf(s);
  const first = await env.DB.prepare('SELECT MIN(time) AS t FROM heartbeats').first<{ t: number | null }>();
  if (!first || first.t == null) return 0;
  let day = dayOf(Math.max(first.t, s.raw_since), tz);
  if (dayStart(day, tz) < s.raw_since) day = addDays(day, 1);
  const today = todayIn(tz);
  const days: string[] = [];
  while (day <= today && days.length < 40000) {
    days.push(day);
    day = addDays(day, 1);
  }
  await markDaysDirty(env, days);
  return days.length;
}

const PRUNE_BATCH = 20000;

/** Daily: drop raw heartbeats older than the retention window (summaries stay forever). */
export async function pruneRaw(env: Env, s: Settings): Promise<void> {
  if (s.raw_retention_days <= 0) return;
  const tz = tzOf(s);
  const today = todayIn(tz);
  if (s.last_prune_day === today) return;

  const cutoffDay = addDays(today, -s.raw_retention_days);
  const cutoff = dayStart(cutoffDay, tz);

  // Make sure every old day has its summary before the raw data goes.
  const { results: pending } = await env.DB.prepare(
    'SELECT day, marked_at FROM dirty_days WHERE day < ?1 ORDER BY day LIMIT 5',
  )
    .bind(cutoffDay)
    .all<{ day: string; marked_at: number }>();
  if (pending.length > 0) {
    for (const r of pending) await recomputeDay(env, s, r.day, r.marked_at);
    return; // prune on a later run, once nothing old is waiting
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('raw_since', ?1), ('last_prune_day', ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(Math.max(cutoff, s.raw_since)), today),
    env.DB.prepare('DELETE FROM heartbeats WHERE id IN (SELECT id FROM heartbeats WHERE time < ?1 LIMIT ?2)').bind(
      cutoff,
      PRUNE_BATCH,
    ),
    env.DB.prepare('DELETE FROM cache WHERE expires < ?1').bind(Math.floor(Date.now() / 1000)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(Math.floor(Date.now() / 1000)),
  ]);
}
