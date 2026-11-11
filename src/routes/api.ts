import { Hono } from 'hono';
import { type C, type AppEnv, cors, requireAuth, viewFor, withSettings } from '../http';
import { MAX_BATCH, ingest } from '../ingest';
import { loadSettings, publicSettingsView, saveSettings, tzOf } from '../settings';
import { clearCache, getStats } from '../stats';
import { flushDirty, markAllRawDaysDirty } from '../summaries';
import { RANGES, addDays, dayStart, durationText, isDay, isValidTimeZone, todayIn } from '../time';

// WakaTime-compatible API. Mounted at both /api/v1 and /api, so the plugin's
// api_url can be either https://your-worker/api/v1 (recommended) or https://your-worker/api

export const api = new Hono<AppEnv>();

api.use('*', async (c, next) => {
  cors(c);
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});
api.use('*', withSettings);

async function handleHeartbeats(c: C) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const items = Array.isArray(body) ? body : [body];
  if (items.length > MAX_BATCH) return c.json({ error: `At most ${MAX_BATCH} heartbeats per request` }, 400);
  const result = await ingest(c.env, c.get('settings'), items, {
    machine: c.req.header('X-Machine-Name') || '',
    ua: c.req.header('User-Agent') || '',
    tz: c.req.header('Timezone') || c.req.header('TimeZone') || '',
  });
  if (!Array.isArray(body)) {
    const [data, status] = result.responses[0];
    return c.json(data as object, status === 201 ? 201 : 400);
  }
  return c.json(result, 202);
}

api.post('/users/current/heartbeats.bulk', requireAuth, handleHeartbeats);
api.post('/users/current/heartbeats', requireAuth, handleHeartbeats);

// Editor status bar ("Today: 2 hrs 10 mins")
api.get('/users/current/statusbar/today', requireAuth, async (c) => {
  const s = c.get('settings');
  const tz = tzOf(s);
  const today = todayIn(tz);
  await flushDirty(c.env, s, 2, [today, addDays(today, -1)]);
  const st = await getStats(c.env, s, { range: 'today', view: 'private' });
  if (!st) return c.json({ error: 'bad range' }, 400);
  const startTs = dayStart(today, tz);
  return c.json({
    cached_at: new Date().toISOString(),
    data: {
      grand_total: {
        decimal: (st.total_seconds / 3600).toFixed(2),
        digital: `${Math.floor(st.total_seconds / 3600)}:${String(Math.floor((st.total_seconds % 3600) / 60)).padStart(2, '0')}`,
        hours: Math.floor(st.total_seconds / 3600),
        minutes: Math.floor((st.total_seconds % 3600) / 60),
        text: durationText(st.total_seconds),
        total_seconds: st.total_seconds,
      },
      categories: st.categories,
      dependencies: [],
      editors: st.editors,
      languages: st.languages,
      machines: st.machines,
      operating_systems: st.operating_systems,
      projects: st.projects,
      range: {
        date: today,
        start: new Date(startTs * 1000).toISOString(),
        end: new Date(dayStart(addDays(today, 1), tz) * 1000 - 1000).toISOString(),
        text: 'Today',
        timezone: tz,
      },
    },
    has_team_features: false,
  });
});

api.get('/users/current', requireAuth, (c) => {
  const s = c.get('settings');
  return c.json({
    data: {
      id: 'current',
      username: s.username,
      display_name: s.display_name || s.username,
      full_name: s.display_name || s.username,
      timezone: tzOf(s),
      is_hireable: false,
      has_premium_features: true,
      plan: 'free-forever',
    },
  });
});

api.post('/users/current/file_experts', requireAuth, (c) => c.json({ data: [] }));

async function handleStats(c: C) {
  const view = viewFor(c);
  if (view === 'unauthorized') return c.json({ error: 'Unauthorized' }, 401);
  if (view === 'denied') return c.json({ error: 'This profile is private' }, 403);
  const range = c.req.param('range') || c.req.query('range') || 'last_7_days';
  const stats = await getStats(c.env, c.get('settings'), {
    range,
    start: c.req.query('start'),
    end: c.req.query('end'),
    view,
  });
  if (!stats) return c.json({ error: `Unknown range. Use one of: ${Object.keys(RANGES).join(', ')}` }, 400);
  c.header('Cache-Control', view === 'public' ? 'public, max-age=300' : 'no-store');
  return c.json({ data: stats });
}

api.get('/users/:user/stats/:range', handleStats);
api.get('/users/:user/stats', handleStats);

api.get('/users/:user/all_time_since_today', async (c) => {
  const view = viewFor(c);
  if (view === 'unauthorized') return c.json({ error: 'Unauthorized' }, 401);
  if (view === 'denied') return c.json({ error: 'This profile is private' }, 403);
  const st = await getStats(c.env, c.get('settings'), { range: 'all_time', view });
  if (!st) return c.json({ error: 'bad range' }, 400);
  return c.json({
    data: {
      decimal: (st.total_seconds / 3600).toFixed(2),
      digital: `${Math.floor(st.total_seconds / 3600)}:${String(Math.floor((st.total_seconds % 3600) / 60)).padStart(2, '0')}`,
      is_up_to_date: true,
      percent_calculated: 100,
      range: { start: st.start, end: st.end, start_date: st.start, end_date: st.end, start_text: st.start, end_text: 'Today', timezone: st.timezone },
      text: durationText(st.total_seconds),
      timeout: c.get('settings').timeout_minutes,
      total_seconds: st.total_seconds,
    },
  });
});

// Per-day summaries, like WakaTime's /summaries (max 366 days per request)
api.get('/users/current/summaries', requireAuth, async (c) => {
  const s = c.get('settings');
  const tz = tzOf(s);
  const today = todayIn(tz);
  let start = c.req.query('start') || '';
  let end = c.req.query('end') || '';
  const rangeName = c.req.query('range');
  if (rangeName) {
    const st = await getStats(c.env, s, { range: rangeName, view: 'private' });
    if (st) {
      start = st.start;
      end = st.end;
    }
  }
  if (!isDay(start)) start = addDays(today, -6);
  if (!isDay(end)) end = today;
  if (start > end) return c.json({ error: 'start must be before end' }, 400);
  if (addDays(start, 366) < end) start = addDays(end, -365);
  await flushDirty(c.env, s, 3);

  const { results } = await c.env.DB.prepare(
    `SELECT day, project, language, editor, os, machine, category, seconds FROM daily_summaries WHERE day BETWEEN ?1 AND ?2`,
  )
    .bind(start, end)
    .all<{ day: string; project: string; language: string; editor: string; os: string; machine: string; category: string; seconds: number }>();

  const byDay = new Map<string, typeof results>();
  for (const r of results) (byDay.get(r.day) || byDay.set(r.day, []).get(r.day)!).push(r);
  const fields: [string, keyof (typeof results)[number], string][] = [
    ['projects', 'project', 'Unknown Project'],
    ['languages', 'language', 'Other'],
    ['editors', 'editor', 'Unknown'],
    ['operating_systems', 'os', 'Unknown'],
    ['machines', 'machine', 'Unknown'],
    ['categories', 'category', 'Coding'],
  ];
  const data = [];
  let cumulative = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const rows = byDay.get(d) || [];
    const total = rows.reduce((a, r) => a + r.seconds, 0);
    cumulative += total;
    const entry: Record<string, unknown> = {
      grand_total: {
        total_seconds: Math.round(total),
        text: durationText(total),
        hours: Math.floor(total / 3600),
        minutes: Math.floor((total % 3600) / 60),
        digital: `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`,
        decimal: (total / 3600).toFixed(2),
      },
      range: { date: d, start: new Date(dayStart(d, tz) * 1000).toISOString(), end: new Date(dayStart(addDays(d, 1), tz) * 1000 - 1000).toISOString(), text: d, timezone: tz },
    };
    for (const [name, col, empty] of fields) {
      const m = new Map<string, number>();
      for (const r of rows) {
        const k = (r[col] as string) || empty;
        m.set(k, (m.get(k) || 0) + r.seconds);
      }
      entry[name] = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([n, secs]) => ({ name: n, total_seconds: Math.round(secs), percent: total ? Math.round((secs / total) * 10000) / 100 : 0, text: durationText(secs) }));
    }
    data.push(entry);
  }
  return c.json({
    data,
    start,
    end,
    cumulative_total: { seconds: Math.round(cumulative), text: durationText(cumulative), decimal: (cumulative / 3600).toFixed(2) },
    daily_average: { seconds: data.length ? Math.round(cumulative / data.length) : 0 },
  });
});

// ---------- Waqt settings (dashboard) ----------

api.get('/users/current/settings', requireAuth, async (c) => {
  const s = c.get('settings');
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM heartbeats) AS heartbeats,
            (SELECT MIN(day) FROM daily_summaries) AS first_day,
            (SELECT COUNT(*) FROM dirty_days) AS pending_days,
            (SELECT MAX(time) FROM heartbeats) AS last_heartbeat`,
  ).first<{ heartbeats: number; first_day: string | null; pending_days: number; last_heartbeat: number | null }>();
  return c.json({ data: { ...publicSettingsView(s), effective_timezone: tzOf(s), stats: counts } });
});

api.put('/users/current/settings', requireAuth, async (c) => {
  const s = c.get('settings');
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const out: Record<string, string> = {};
  const errors: string[] = [];
  if ('timezone' in body) {
    if (typeof body.timezone === 'string' && isValidTimeZone(body.timezone)) out.timezone = body.timezone;
    else errors.push('timezone is not a valid IANA time zone');
  }
  if ('username' in body) {
    const u = String(body.username || '').trim();
    if (/^[A-Za-z0-9_.-]{1,39}$/.test(u) && u !== 'current') out.username = u;
    else errors.push('username may only use letters, numbers, _ . - (max 39)');
  }
  if ('display_name' in body) out.display_name = String(body.display_name || '').slice(0, 60);
  if ('public_enabled' in body) out.public_enabled = body.public_enabled ? '1' : '0';
  if ('public_projects' in body) out.public_projects = body.public_projects ? '1' : '0';
  if ('hidden_projects' in body) {
    const list = Array.isArray(body.hidden_projects) ? body.hidden_projects : [];
    out.hidden_projects = JSON.stringify(list.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 200));
  }
  if ('timeout_minutes' in body) {
    const n = Math.trunc(Number(body.timeout_minutes));
    if (n >= 1 && n <= 120) out.timeout_minutes = String(n);
    else errors.push('timeout_minutes must be 1–120');
  }
  if ('raw_retention_days' in body) {
    const n = Math.trunc(Number(body.raw_retention_days));
    if (n === 0 || (n >= 30 && n <= 36500)) out.raw_retention_days = String(n);
    else errors.push('raw_retention_days must be 0 (keep forever) or at least 30');
  }
  if (errors.length) return c.json({ error: errors.join('; ') }, 400);

  await saveSettings(c.env.DB, out);
  await clearCache(c.env);
  const next = await loadSettings(c.env.DB);
  let rebuilding = 0;
  if ((out.timezone && out.timezone !== s.timezone) || (out.timeout_minutes && Number(out.timeout_minutes) !== s.timeout_minutes)) {
    rebuilding = await markAllRawDaysDirty(c.env, next);
  }
  return c.json({ data: { ...publicSettingsView(next), effective_timezone: tzOf(next), rebuilding_days: rebuilding } });
});

