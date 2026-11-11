import { Env, Settings, tzOf } from './settings';
import { flushDirty } from './summaries';
import { Range, addDays, daysBetween, durationItem, durationText, resolveRange, todayIn } from './time';

export type View = 'public' | 'private';

const DIMS = ['languages', 'projects', 'editors', 'operating_systems', 'machines', 'categories'] as const;
type Dim = (typeof DIMS)[number];

const EMPTY_NAMES: Record<Dim, string> = {
  languages: 'Other',
  projects: 'Unknown Project',
  editors: 'Unknown',
  operating_systems: 'Unknown',
  machines: 'Unknown',
  categories: 'Coding',
};

// D1 caps compound SELECTs, so instead of UNION ALL we "unpivot" with json_each:
// each summary row is counted once per dimension, grouped in a single query.
const STATS_SQL = `
SELECT d.value AS dim,
  CASE d.value
    WHEN 'languages' THEN r.language
    WHEN 'projects' THEN r.project
    WHEN 'editors' THEN r.editor
    WHEN 'operating_systems' THEN r.os
    WHEN 'machines' THEN r.machine
    WHEN 'categories' THEN r.category
    ELSE r.day
  END AS name,
  SUM(r.seconds) AS secs, SUM(r.ai_lines) AS ai, SUM(r.human_lines) AS hu
FROM daily_summaries r
JOIN json_each('["languages","projects","editors","operating_systems","machines","categories","days"]') d
WHERE r.day BETWEEN ?1 AND ?2
GROUP BY dim, name`;

interface StatRow {
  dim: string;
  name: string;
  secs: number;
  ai: number;
  hu: number;
}

export type Item = ReturnType<typeof durationItem>;

export interface DayTotal {
  date: string;
  total_seconds: number;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function firstDay(env: Env): Promise<string | null> {
  const r = await env.DB.prepare('SELECT MIN(day) AS d FROM daily_summaries').first<{ d: string | null }>();
  return r?.d ?? null;
}

export function streaks(days: DayTotal[], today: string, minSeconds = 60) {
  const active = new Set(days.filter((d) => d.total_seconds >= minSeconds).map((d) => d.date));
  let longest = 0;
  let run = 0;
  let prev = '';
  for (const d of [...active].sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  let cursor = active.has(today) ? today : addDays(today, -1);
  while (active.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

/** WakaTime-compatible stats object for a range, plus a few extras Waqt uses. */
export async function buildStats(env: Env, s: Settings, range: Range, view: View) {
  const { results } = await env.DB.prepare(STATS_SQL).bind(range.start, range.end).all<StatRow>();
  const tz = tzOf(s);
  const grouped: Record<string, StatRow[]> = {};
  for (const r of results) (grouped[r.dim] ||= []).push(r);

  const dayRows = (grouped.days || []).sort((a, b) => (a.name < b.name ? -1 : 1));
  const total = dayRows.reduce((acc, r) => acc + r.secs, 0);
  const days: DayTotal[] = dayRows.map((r) => ({ date: r.name, total_seconds: Math.round(r.secs) }));
  const activeDays = days.filter((d) => d.total_seconds > 0).length;
  const aiLines = dayRows.reduce((a, r) => a + (r.ai || 0), 0);
  const humanLines = dayRows.reduce((a, r) => a + (r.hu || 0), 0);
  const best = days.reduce<DayTotal | null>((b, d) => (!b || d.total_seconds > b.total_seconds ? d : b), null);

  const hidden = new Set(s.hidden_projects.map((p) => p.toLowerCase()));
  const lists: Partial<Record<Dim, Item[]>> = {};
  for (const dim of DIMS) {
    if (view === 'public' && dim === 'machines') continue;
    if (view === 'public' && dim === 'projects' && !s.public_projects) continue;
    const merged = new Map<string, number>();
    for (const r of grouped[dim] || []) {
      if (view === 'public' && dim === 'projects' && hidden.has((r.name || '').toLowerCase())) continue;
      let name = r.name || EMPTY_NAMES[dim];
      if (dim === 'categories') name = titleCase(name).replace(/^Ai\b/, 'AI');
      merged.set(name, (merged.get(name) || 0) + r.secs);
    }
    lists[dim] = [...merged.entries()]
      .filter(([, secs]) => secs > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, secs]) => durationItem(name, secs, total));
  }

  const avg = activeDays ? total / activeDays : 0;
  const today = todayIn(tz);
  return {
    username: s.username,
    user_id: 'current',
    display_name: s.display_name || s.username,
    range: range.name,
    human_readable_range: range.label,
    start: range.start,
    end: range.end,
    timezone: tz,
    total_seconds: Math.round(total),
    human_readable_total: durationText(total),
    daily_average: Math.round(avg),
    human_readable_daily_average: durationText(avg),
    days_including_holidays: daysBetween(range.start, range.end),
    days_minus_holidays: activeDays,
    holidays: daysBetween(range.start, range.end) - activeDays,
    best_day: best && best.total_seconds > 0 ? { date: best.date, total_seconds: best.total_seconds, text: durationText(best.total_seconds) } : null,
    languages: lists.languages || [],
    editors: lists.editors || [],
    operating_systems: lists.operating_systems || [],
    categories: lists.categories || [],
    projects: lists.projects,
    machines: lists.machines,
    dependencies: [] as Item[],
    ai_lines: aiLines,
    human_lines: humanLines,
    streak: range.end === today ? streaks(days, today) : null,
    days,
    is_coding_activity_visible: true,
    is_other_usage_visible: true,
    is_up_to_date: true,
    is_up_to_date_pending_future: false,
    is_stuck: false,
    is_already_updating: false,
    status: 'ok',
    percent_calculated: 100,
  };
}

export type Stats = Awaited<ReturnType<typeof buildStats>>;

const PUBLIC_TTL = 600; // seconds

/**
 * Public stats go through a small cache so a popular README or website
 * costs one D1 row read per visit instead of thousands.
 */
export async function getStats(
  env: Env,
  s: Settings,
  opts: { range?: string; start?: string; end?: string; view: View; fresh?: boolean },
): Promise<Stats | null> {
  const tz = tzOf(s);
  if (!resolveRange(opts.range, tz, null, opts.start, opts.end)) return null;

  const key = `stats:v1:${opts.view}:${opts.range || ''}:${opts.start || ''}:${opts.end || ''}:${todayIn(tz)}`;
  const now = Math.floor(Date.now() / 1000);
  if (opts.view === 'public' && !opts.fresh) {
    const hit = await env.DB.prepare('SELECT value FROM cache WHERE key = ?1 AND expires > ?2')
      .bind(key, now)
      .first<{ value: string }>();
    if (hit) return JSON.parse(hit.value);
  }

  // Bring recent days up to date first (cron catches up on anything older).
  await flushDirty(env, s, 3);
  const first = opts.range === 'all_time' ? await firstDay(env) : null;
  const range = resolveRange(opts.range, tz, first, opts.start, opts.end)!;
  const stats = await buildStats(env, s, range, opts.view);

  if (opts.view === 'public') {
    await env.DB.prepare(
      `INSERT INTO cache (key, value, expires) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires`,
    )
      .bind(key, JSON.stringify(stats), now + PUBLIC_TTL)
      .run();
  }
  return stats;
}

export async function clearCache(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM cache').run();
}
