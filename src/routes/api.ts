import { Hono } from 'hono';
import { type C, type AppEnv, cors, requireAuth, requireDevice, viewFor, withSettings } from '../http';
import { forwardHeartbeats, forwardHost, forwardKey, forwardQueueSize, forwardingEnabled } from '../forward';
import { MAX_BATCH, ingest } from '../ingest';
import { importer } from './importer';
import { backup } from './backup';
import { account, auth } from './auth';
import { buildReport, sendReport } from '../report';
import { reparseUserAgents } from '../maintenance';
import { usageReport } from '../usage';
import { versionInfo } from '../version';
import { cleanPrices } from '../pricing';
import { FRIEND_RANGES, MAX_FRIENDS, cleanFriends, leaderboard } from '../friends';
import { aliasOf, loadSettings, publicSettingsView, saveSettings, tzOf } from '../settings';
import { clearCache, getStats, streaks } from '../stats';
import { README_SECTIONS, renderReadme } from '../readme';
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
  const headers = {
    machine: c.req.header('X-Machine-Name') || '',
    ua: c.req.header('User-Agent') || '',
    tz: c.req.header('Timezone') || c.req.header('TimeZone') || '',
  };
  const s = c.get('settings');
  const result = await ingest(c.env, s, items, headers);
  // Pass the original heartbeats on to WakaTime in the background, if enabled.
  if (forwardingEnabled(c.env, s)) c.executionCtx.waitUntil(forwardHeartbeats(c.env, s, items, headers));
  if (!Array.isArray(body)) {
    const [data, status] = result.responses[0];
    return c.json(data as object, status === 201 ? 201 : 400);
  }
  return c.json(result, 202);
}

api.post('/users/current/heartbeats.bulk', requireDevice, handleHeartbeats);
api.post('/users/current/heartbeats', requireDevice, handleHeartbeats);

// Editor status bar ("Today: 2 hrs 10 mins")
api.get('/users/current/statusbar/today', requireDevice, async (c) => {
  const s = c.get('settings');
  const tz = tzOf(s);
  const today = todayIn(tz);
  await flushDirty(c.env, s, 2, [today, addDays(today, -1)]);
  const st = await getStats(c.env, s, { range: 'today', view: 'private' });
  if (!st) return c.json({ error: 'bad range' }, 400);
  const startTs = dayStart(today, tz);
  // Goal progress in the status bar. The CLI only shows grand_total.text when there
  // are fewer than 2 categories, so they're folded into one.
  const goal = s.statusbar_goal && s.goal_daily_minutes ? s.goal_daily_minutes * 60 : 0;
  let text = durationText(st.total_seconds);
  if (goal) {
    text += st.total_seconds >= goal ? ' · goal ✓' : ` · ${Math.floor((st.total_seconds / goal) * 100)}% of ${durationText(goal)}`;
  }
  const categories = goal ? [{ name: 'Coding', total_seconds: st.total_seconds, percent: 100, text, digital: '', hours: 0, minutes: 0 }] : st.categories;
  return c.json({
    cached_at: new Date().toISOString(),
    data: {
      grand_total: {
        decimal: (st.total_seconds / 3600).toFixed(2),
        digital: `${Math.floor(st.total_seconds / 3600)}:${String(Math.floor((st.total_seconds % 3600) / 60)).padStart(2, '0')}`,
        hours: Math.floor(st.total_seconds / 3600),
        minutes: Math.floor((st.total_seconds % 3600) / 60),
        text,
        total_seconds: st.total_seconds,
      },
      categories,
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

api.get('/users/current', requireDevice, (c) => {
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

api.post('/users/current/file_experts', requireDevice, (c) => c.json({ data: [] }));

async function handleStats(c: C) {
  const view = await viewFor(c);
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

// Markdown block for profile READMEs (see readme-action/).
api.get('/users/:user/readme.md', async (c) => {
  const view = await viewFor(c);
  if (view === 'unauthorized') return c.text('Unauthorized', 401);
  if (view === 'denied') return c.text('This profile is private', 403);
  const s = c.get('settings');
  const range = c.req.query('range') || 'last_7_days';
  const st = await getStats(c.env, s, { range, view });
  if (!st) return c.text(`Unknown range. Use one of: ${Object.keys(RANGES).join(', ')}`, 400);
  const year = range === 'last_year' ? st : await getStats(c.env, s, { range: 'last_year', view });
  const sections = (c.req.query('sections') || '').split(',').map((x) => x.trim()).filter((x) => README_SECTIONS.includes(x));
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  return c.body(renderReadme(st, sections, year ? streaks(year.days, year.end) : null, s.site_url));
});

api.get('/users/:user/all_time_since_today', async (c) => {
  const view = await viewFor(c);
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
api.get('/users/current/summaries', requireDevice, async (c) => {
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
        let k = (r[col] as string) || empty;
        if (col === 'project' && r.project) k = aliasOf(s, r.project);
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
    // Row ids grow by one per heartbeat, so this counts them without reading them all.
    `SELECT COALESCE((SELECT MAX(id) FROM heartbeats) - (SELECT MIN(id) FROM heartbeats) + 1, 0) AS heartbeats,
            (SELECT MIN(day) FROM daily_summaries) AS first_day,
            (SELECT COUNT(*) FROM dirty_days) AS pending_days,
            (SELECT MAX(time) FROM heartbeats) AS last_heartbeat`,
  ).first<{ heartbeats: number; first_day: string | null; pending_days: number; last_heartbeat: number | null }>();
  return c.json({
    data: {
      ...publicSettingsView(s),
      effective_timezone: tzOf(s),
      ...versionInfo(s),
      stats: counts,
      forwarding: forwardKey(c.env)
        ? { to: forwardHost(c.env), enabled: s.forward_enabled, error: s.forward_error, queued: await forwardQueueSize(c.env) }
        : null,
    },
  });
});

// Send this week's report right now, to check the setup.
api.post('/users/current/report/test', requireAuth, async (c) => {
  const s = c.get('settings');
  const r = await buildReport(c.env, s, todayIn(tzOf(s)), s.site_url);
  const result = await sendReport(c.env, s, r);
  return c.json({ data: { ...result, preview: [r.title, ...r.lines] } });
});

// Time per day and project (after renames), with labels and rates, for Timesheets.
api.get('/users/current/timesheet', requireAuth, async (c) => {
  const s = c.get('settings');
  const start = c.req.query('start') || '';
  const end = c.req.query('end') || '';
  if (!isDay(start) || !isDay(end) || start > end) return c.json({ error: 'start and end must be YYYY-MM-DD, start first' }, 400);
  if (addDays(start, 366) < end) return c.json({ error: 'At most one year at a time' }, 400);
  await flushDirty(c.env, s, 2);
  const { results } = await c.env.DB.prepare(
    'SELECT day, project, SUM(seconds) AS secs FROM daily_summaries WHERE day BETWEEN ?1 AND ?2 GROUP BY day, project',
  )
    .bind(start, end)
    .all<{ day: string; project: string; secs: number }>();
  const merged = new Map<string, { day: string; project: string; label: string; seconds: number }>();
  for (const r of results) {
    const project = r.project ? aliasOf(s, r.project) : 'Unknown Project';
    const key = `${r.day}\u0000${project}`;
    const row = merged.get(key) || { day: r.day, project, label: s.project_labels[project] || '', seconds: 0 };
    row.seconds += r.secs;
    merged.set(key, row);
  }
  const rows = [...merged.values()]
    .filter((r) => r.seconds >= 1)
    .map((r) => ({ ...r, seconds: Math.round(r.seconds) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : b.seconds - a.seconds));
  return c.json({ data: { start, end, currency: s.currency, rates: s.label_rates, display_name: s.display_name || s.username, rows } });
});

// Estimated usage against Cloudflare's free-plan limits.
api.get('/users/current/usage', requireAuth, async (c) => {
  const report = await usageReport(c.env.DB);
  // (One MIN or MAX per SELECT, so SQLite answers each from the index.)
  const raw = await c.env.DB.prepare(
    'SELECT COALESCE((SELECT MAX(id) FROM heartbeats) - (SELECT MIN(id) FROM heartbeats) + 1, 0) AS n',
  ).first<{ n: number }>();
  return c.json({ data: { ...report, raw_heartbeats: raw?.n || 0, raw_retention_days: c.get('settings').raw_retention_days } });
});

// Heartbeat inspector: the latest heartbeats exactly as stored, with the raw user agent.
api.get('/users/current/heartbeats/recent', requireAuth, async (c) => {
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(c.req.query('limit'))) || 50));
  const project = c.req.query('project') || '';
  const { results } = await c.env.DB.prepare(
    `SELECT h.time, h.project, h.language, h.editor, h.os, h.machine, h.category, h.branch, h.entity, h.is_write,
            h.ai_model, h.ai_session, h.ai_line_changes, h.human_line_changes, u.value AS user_agent
     FROM heartbeats h LEFT JOIN user_agents u ON u.id = h.user_agent_id
     WHERE (?1 = '' OR h.project = ?1)
     ORDER BY h.time DESC LIMIT ?2`,
  )
    .bind(project, limit)
    .all();
  const projects = await c.env.DB.prepare(
    // Projects among the latest heartbeats only, so this doesn't read the whole table.
    `SELECT project, MAX(time) AS last FROM (SELECT project, time FROM heartbeats ORDER BY time DESC LIMIT 3000)
     GROUP BY project ORDER BY last DESC LIMIT 100`,
  ).all<{ project: string }>();
  return c.json({ data: { heartbeats: results, projects: projects.results.map((p) => p.project) } });
});

// Re-read every stored user agent now (normally done automatically after upgrades).
api.post('/users/current/maintenance/reparse', requireAuth, async (c) => {
  const changed = await reparseUserAgents(c.env, c.get('settings'));
  await clearCache(c.env);
  return c.json({ data: { changed } });
});

// Every project name ever seen (before renames), for the Projects tab.
api.get('/users/current/projects', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT project AS name, SUM(seconds) AS secs, MIN(day) AS first_day, MAX(day) AS last_day
     FROM daily_summaries GROUP BY project ORDER BY secs DESC LIMIT 1000`,
  ).all<{ name: string; secs: number; first_day: string; last_day: string }>();
  return c.json({
    data: results.map((r) => ({ name: r.name, total_seconds: Math.round(r.secs), text: durationText(r.secs), first_day: r.first_day, last_day: r.last_day })),
  });
});

// Leaderboard with friends (their public stats), you included.
api.get('/users/current/friends', requireAuth, async (c) => {
  const s = c.get('settings');
  const range = c.req.query('range') || 'last_7_days';
  if (!(FRIEND_RANGES as readonly string[]).includes(range)) return c.json({ error: `range must be one of ${FRIEND_RANGES.join(', ')}` }, 400);
  const st = await getStats(c.env, s, { range, view: 'private' });
  const you = { name: s.display_name || 'You', total_seconds: st?.total_seconds || 0, daily_average: st?.daily_average || 0, languages: st?.languages || [] };
  const rows = await leaderboard(c.env.DB, s.friends, range, you, new URL(c.req.url).origin);
  return c.json({ data: { range, rows } });
});

// One project in detail: daily time, languages, branches and files.
api.get('/users/current/project', requireAuth, async (c) => {
  const s = c.get('settings');
  const name = c.req.query('name');
  if (name === undefined) return c.json({ error: 'name is required' }, 400);
  const days = Math.min(36500, Math.max(0, Math.trunc(Number(c.req.query('days') ?? 30)) || 0));
  const today = todayIn(tzOf(s));
  const start = days ? addDays(today, -(days - 1)) : '0000-01-01';
  // Every stored name that is shown as this one (renames and merges).
  const raw = new Set<string>();
  if (aliasOf(s, name) === name) raw.add(name);
  for (const [from, to] of Object.entries(s.project_aliases)) if (to === name) raw.add(from);
  if (!raw.size) raw.add(name);
  const names = JSON.stringify([...raw]);
  await flushDirty(c.env, s, 2);

  const q = (sql: string) => c.env.DB.prepare(sql).bind(names, start, today);
  const inProject = 'project IN (SELECT value FROM json_each(?1)) AND day BETWEEN ?2 AND ?3';
  const [daily, langs, editors, branches, files] = await c.env.DB.batch([
    q(`SELECT day, SUM(seconds) AS secs FROM daily_summaries WHERE ${inProject} GROUP BY day ORDER BY day`),
    q(`SELECT language AS name, SUM(seconds) AS secs FROM daily_summaries WHERE ${inProject} GROUP BY language ORDER BY secs DESC LIMIT 50`),
    q(`SELECT editor AS name, SUM(seconds) AS secs FROM daily_summaries WHERE ${inProject} GROUP BY editor ORDER BY secs DESC LIMIT 20`),
    q(`SELECT branch AS name, SUM(seconds) AS secs, MAX(day) AS last_day FROM daily_files WHERE ${inProject} GROUP BY branch ORDER BY secs DESC LIMIT 100`),
    q(`SELECT entity AS name, SUM(seconds) AS secs, MAX(day) AS last_day FROM daily_files WHERE ${inProject} GROUP BY entity ORDER BY secs DESC LIMIT 200`),
  ]);
  type R = { name: string; secs: number; last_day?: string };
  const item = (r: R, fallback: string) => ({
    name: r.name && r.name !== '<<LAST_LANGUAGE>>' ? r.name : fallback,
    total_seconds: Math.round(r.secs),
    text: durationText(r.secs),
    ...(r.last_day ? { last_day: r.last_day } : {}),
  });
  const dayRows = daily.results as { day: string; secs: number }[];
  const total = dayRows.reduce((a, r) => a + r.secs, 0);
  return c.json({
    data: {
      name,
      names: [...raw],
      label: s.project_labels[name] || '',
      start: days ? start : dayRows[0]?.day || today,
      end: today,
      total_seconds: Math.round(total),
      text: durationText(total),
      active_days: dayRows.filter((r) => r.secs >= 60).length,
      first_day: dayRows[0]?.day || null,
      last_day: dayRows[dayRows.length - 1]?.day || null,
      days: dayRows.map((r) => ({ date: r.day, total_seconds: Math.round(r.secs) })),
      languages: (langs.results as R[]).map((r) => item(r, 'Other')).filter((r) => r.total_seconds > 0),
      editors: (editors.results as R[]).map((r) => item(r, 'Unknown')).filter((r) => r.total_seconds > 0),
      branches: (branches.results as R[]).map((r) => item(r, 'No branch')).filter((r) => r.total_seconds > 0),
      files: (files.results as R[]).map((r) => item(r, 'Other files')).filter((r) => r.total_seconds > 0),
    },
  });
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
  if ('forward_enabled' in body) out.forward_enabled = body.forward_enabled ? '1' : '0';
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
  const strMap = (v: unknown, max: number): Record<string, string> | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v).slice(0, max)) {
      const from = String(k).trim().slice(0, 200);
      const to = String(val ?? '').trim().slice(0, 200);
      if (from && to && from !== to) out[from] = to;
    }
    return out;
  };
  if ('project_aliases' in body) {
    const m = strMap(body.project_aliases, 1000);
    if (m) out.project_aliases = JSON.stringify(m);
    else errors.push('project_aliases must be an object of "old name": "new name"');
  }
  if ('project_labels' in body) {
    const m = strMap(body.project_labels, 1000);
    if (m) out.project_labels = JSON.stringify(m);
    else errors.push('project_labels must be an object of "project": "label"');
  }
  if ('goal_daily_minutes' in body) {
    const n = Math.trunc(Number(body.goal_daily_minutes));
    if (n >= 0 && n <= 1440) out.goal_daily_minutes = String(n);
    else errors.push('goal_daily_minutes must be 0–1440');
  }
  if ('goal_weekly_hours' in body) {
    const n = Math.trunc(Number(body.goal_weekly_hours));
    if (n >= 0 && n <= 168) out.goal_weekly_hours = String(n);
    else errors.push('goal_weekly_hours must be 0–168');
  }
  if ('ai_prices' in body) {
    if (body.ai_prices === null) out.ai_prices = '';
    else {
      const prices = cleanPrices(body.ai_prices);
      if (prices) out.ai_prices = JSON.stringify(prices);
      else errors.push('ai_prices must be a list of [name, input, output, cached] prices per million tokens');
    }
  }
  if ('ai_cost_public' in body) out.ai_cost_public = body.ai_cost_public ? '1' : '0';
  if ('friends' in body) {
    const friends = cleanFriends(body.friends);
    if (friends) out.friends = JSON.stringify(friends);
    else errors.push(`friends must be a list of up to ${MAX_FRIENDS} { name, url } with web addresses`);
  }
  for (const k of ['nudge_goal', 'nudge_streak', 'statusbar_goal'] as const) if (k in body) out[k] = body[k] ? '1' : '0';
  if ('nudge_streak_hour' in body) {
    const n = Math.trunc(Number(body.nudge_streak_hour));
    if (n >= 0 && n <= 23) out.nudge_streak_hour = String(n);
    else errors.push('nudge_streak_hour must be 0–23');
  }
  if ('report_enabled' in body) out.report_enabled = body.report_enabled ? '1' : '0';
  // Secrets: undefined = keep as is, '' = remove, otherwise replace.
  if (typeof body.report_discord === 'string') {
    const u = body.report_discord.trim();
    if (!u || /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(u) || /^https?:\/\/127\.0\.0\.1[:/]/.test(u)) out.report_discord = u;
    else errors.push('The Discord webhook should start with https://discord.com/api/webhooks/');
  }
  if (typeof body.report_telegram_token === 'string') {
    const t = body.report_telegram_token.trim();
    if (!t || /^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) out.report_telegram_token = t;
    else errors.push('The Telegram bot token looks like 123456789:ABC… (from @BotFather)');
  }
  if ('report_telegram_chat' in body) {
    const chat = String(body.report_telegram_chat ?? '').trim();
    if (!chat || /^-?\d{1,20}$|^@[A-Za-z0-9_]{4,}$/.test(chat)) out.report_telegram_chat = chat;
    else errors.push('The Telegram chat ID is a number (or @channel)');
  }
  if ('label_rates' in body) {
    const r = body.label_rates;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(r).slice(0, 500)) {
        const n = Number(v);
        if (k.trim() && Number.isFinite(n) && n >= 0 && n < 1e7) clean[k.trim().slice(0, 200)] = Math.round(n * 100) / 100;
      }
      out.label_rates = JSON.stringify(clean);
    } else errors.push('label_rates must be an object of "label": rate');
  }
  if ('currency' in body) {
    const cur = String(body.currency || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(cur)) out.currency = cur;
    else errors.push('currency must be a 3-letter code like USD or INR');
  }
  if (typeof body.site_url === 'string' && /^https?:\/\/[^\s/]+$/.test(body.site_url)) out.site_url = body.site_url;
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

api.route('/users/current/import', importer);
api.route('/users/current/backup', backup);
api.route('/users/current', account);
api.route('/auth', auth);
