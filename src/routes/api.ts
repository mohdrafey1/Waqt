import { Hono } from 'hono';
import { type C, type AppEnv, cors, requireAuth, viewFor, withSettings } from '../http';
import { forwardHeartbeats, forwardHost, forwardKey, forwardQueueSize, forwardingEnabled } from '../forward';
import { MAX_BATCH, ingest } from '../ingest';
import { importer } from './importer';
import { buildReport, sendReport } from '../report';
import { reparseUserAgents } from '../maintenance';
import { usageReport } from '../usage';
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

// Markdown block for profile READMEs (see readme-action/).
api.get('/users/:user/readme.md', async (c) => {
  const view = viewFor(c);
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
    `SELECT (SELECT COUNT(*) FROM heartbeats) AS heartbeats,
            (SELECT MIN(day) FROM daily_summaries) AS first_day,
            (SELECT COUNT(*) FROM dirty_days) AS pending_days,
            (SELECT MAX(time) FROM heartbeats) AS last_heartbeat`,
  ).first<{ heartbeats: number; first_day: string | null; pending_days: number; last_heartbeat: number | null }>();
  return c.json({
    data: {
      ...publicSettingsView(s),
      effective_timezone: tzOf(s),
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
  const raw = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM heartbeats').first<{ n: number }>();
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
    'SELECT project, MAX(time) AS last FROM heartbeats GROUP BY project ORDER BY last DESC LIMIT 100',
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
