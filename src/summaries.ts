import { Env, Settings, tzOf } from './settings';
import { addDays, dayStart, dayOf, todayIn } from './time';

interface HbRow {
  time: number;
  project: string;
  language: string;
  editor: string;
  os: string;
  machine: string;
  category: string;
  ai: number | null;
  hu: number | null;
}

/**
 * Turn a day's heartbeats into time. Each heartbeat is credited with the gap
 * until the next one, as long as that gap is under the timeout (default 15 min),
 * the same way WakaTime counts time.
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
    `SELECT time, project, language, editor, os, machine, category,
            ai_line_changes AS ai, human_line_changes AS hu
     FROM heartbeats WHERE time >= ?1 AND time < ?2 ORDER BY time`,
  )
    .bind(start, end + timeout)
    .all<HbRow>();

  const agg = new Map<string, [string, string, string, string, string, string, number, number, number]>();
  for (let i = 0; i < results.length; i++) {
    const h = results[i];
    if (h.time >= end) break;
    const next = results[i + 1];
    let credit = 0;
    if (next && next.time - h.time <= timeout) credit = Math.min(next.time, end) - h.time;
    const key = `${h.project}\u0000${h.language}\u0000${h.editor}\u0000${h.os}\u0000${h.machine}\u0000${h.category}`;
    let row = agg.get(key);
    if (!row) {
      row = [h.project, h.language, h.editor, h.os, h.machine, h.category, 0, 0, 0];
      agg.set(key, row);
    }
    row[6] += credit;
    row[7] += h.ai || 0;
    row[8] += h.hu || 0;
  }
  const rows = [...agg.values()].filter((r) => r[6] > 0 || r[7] || r[8]).map((r) => {
    r[6] = Math.round(r[6] * 1000) / 1000;
    return r;
  });

  await env.DB.batch([
    env.DB.prepare('DELETE FROM daily_summaries WHERE day = ?1').bind(day),
    env.DB.prepare(
      `INSERT INTO daily_summaries (day, project, language, editor, os, machine, category, seconds, ai_lines, human_lines)
       SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
              json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'),
              json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]')
       FROM json_each(?2)`,
    ).bind(day, JSON.stringify(rows)),
    // Only clear the flag if no newer heartbeat re-marked the day while we worked.
    env.DB.prepare('DELETE FROM dirty_days WHERE day = ?1 AND marked_at <= ?2').bind(day, markedAt),
  ]);
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
    'SELECT day, marked_at FROM dirty_days WHERE day < ?1 ORDER BY day LIMIT 10',
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
  ]);
}
