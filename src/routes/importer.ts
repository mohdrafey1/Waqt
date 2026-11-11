import { Hono } from 'hono';
import { forwardKey } from '../forward';
import { type AppEnv, type C, requireAuth } from '../http';
import { Settings, saveSettings, tzOf } from '../settings';
import { clearCache } from '../stats';
import { replaceDaysStatements } from '../summaries';
import { dayOf, dayStart, isDay } from '../time';

// Import your history from WakaTime.
//
// The free Workers plan allows only a few milliseconds of CPU per request, so the
// Worker never parses the (possibly huge) export itself. It asks WakaTime for a
// "data dump", streams the file through to your browser, and your browser counts
// the time (with the same code as the server, public/lib/core.js) and sends back
// compact daily totals. Imported days are stored with source = 'import', so live
// data is never overwritten and re-importing simply replaces the old import.

export const importer = new Hono<AppEnv>();
importer.use('*', requireAuth);

// WAKATIME_IMPORT_URL is only for testing against a fake WakaTime.
const wakatime = (c: C) => ((c.env as { WAKATIME_IMPORT_URL?: string }).WAKATIME_IMPORT_URL || 'https://api.wakatime.com/api/v1').replace(/\/+$/, '');
const MAX_DAYS_PER_REQUEST = 62;

function wakaHeaders(c: C): Record<string, string> {
  return { Authorization: 'Basic ' + btoa(forwardKey(c.env)), Accept: 'application/json', 'Content-Type': 'application/json' };
}

/** Unix time where Waqt's own data begins; WakaTime data is only imported before this. */
async function ownSince(c: C, s: Settings): Promise<number> {
  if (s.first_heartbeat) return s.first_heartbeat;
  const raw = await c.env.DB.prepare('SELECT MIN(time) AS t FROM heartbeats').first<{ t: number | null }>();
  const live = await c.env.DB.prepare("SELECT MIN(day) AS d FROM daily_summaries WHERE source = 'live'").first<{ d: string | null }>();
  const candidates = [raw?.t ?? null, live?.d ? dayStart(live.d, tzOf(s)) : null].filter((x): x is number => x != null);
  if (!candidates.length) return 0;
  const t = Math.min(...candidates);
  await saveSettings(c.env.DB, { first_heartbeat: String(t) });
  return t;
}

type Dump = { id: string; type: string; status: string; percent_complete: number; download_url: string; expires: string; has_failed: boolean; is_stuck: boolean };

async function latestHeartbeatsDump(c: C): Promise<Dump | null> {
  const res = await fetch(`${wakatime(c)}/users/current/data_dumps`, { headers: wakaHeaders(c) });
  if (res.status === 401) throw new Error('WakaTime rejected the WAKATIME_API_KEY secret.');
  if (!res.ok) throw new Error(`WakaTime answered with status ${res.status}.`);
  const body = (await res.json()) as { data?: Dump[] };
  const dumps = (body.data || []).filter((d) => d.type === 'heartbeats');
  return dumps[0] || null;
}

importer.get('/status', async (c) => {
  const s = c.get('settings');
  const since = await ownSince(c, s);
  const imported = await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT day) AS days, MIN(day) AS first, MAX(day) AS last, SUM(seconds) AS secs FROM daily_summaries WHERE source = 'import'",
  ).first<{ days: number; first: string | null; last: string | null; secs: number | null }>();
  return c.json({
    data: {
      wakatime_key: !!forwardKey(c.env),
      own_since: since,
      own_since_day: since ? dayOf(since, tzOf(s)) : null,
      timezone: tzOf(s),
      timeout_minutes: s.timeout_minutes,
      imported: { days: imported?.days || 0, first: imported?.first, last: imported?.last, seconds: Math.round(imported?.secs || 0) },
    },
  });
});

// Ask WakaTime to prepare an export of all heartbeats (or report on the one in progress).
importer.post('/wakatime/dump', async (c) => {
  if (!forwardKey(c.env)) return c.json({ error: 'Add your WakaTime key as the WAKATIME_API_KEY secret first.' }, 400);
  try {
    let dump = await latestHeartbeatsDump(c);
    const expired = dump && dump.expires && Date.parse(dump.expires) < Date.now();
    if (!dump || expired || dump.has_failed) {
      const res = await fetch(`${wakatime(c)}/users/current/data_dumps`, {
        method: 'POST',
        headers: wakaHeaders(c),
        body: JSON.stringify({ type: 'heartbeats', email_when_finished: false }),
      });
      if (!res.ok && res.status !== 400) {
        const t = await res.text();
        return c.json({ error: `WakaTime could not start the export (${res.status}): ${t.slice(0, 200)}` }, 502);
      }
      // 400 usually means "wait for your current export to expire": reuse it.
      dump = await latestHeartbeatsDump(c);
    }
    if (!dump) return c.json({ data: { status: 'starting', percent: 0, ready: false } });
    return c.json({
      data: {
        status: dump.status,
        percent: Math.round(dump.percent_complete || 0),
        ready: dump.status === 'Completed' && !!dump.download_url,
        failed: dump.has_failed || dump.is_stuck,
        expires: dump.expires,
      },
    });
  } catch (e) {
    return c.json({ error: String((e as Error).message || e) }, 502);
  }
});

// Stream the finished export through to the browser (no parsing here).
importer.get('/wakatime/download', async (c) => {
  if (!forwardKey(c.env)) return c.json({ error: 'WAKATIME_API_KEY is not set.' }, 400);
  const dump = await latestHeartbeatsDump(c).catch(() => null);
  if (!dump || dump.status !== 'Completed' || !dump.download_url) return c.json({ error: 'The export is not ready yet.' }, 409);
  const url = new URL(dump.download_url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return c.json({ error: 'Unexpected download URL.' }, 502);
  const file = await fetch(url.toString());
  if (!file.ok || !file.body) return c.json({ error: `Download failed (${file.status}).` }, 502);
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  const len = file.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);
  return new Response(file.body, { headers });
});

// Editor / OS / AI model names and machine names, which the export only references by id.
importer.get('/wakatime/lookups', async (c) => {
  if (!forwardKey(c.env)) return c.json({ data: { user_agents: {}, machines: {} } });
  const userAgents: Record<string, { editor: string; os: string; ai_model: string; value: string }> = {};
  const machines: Record<string, string> = {};
  const pages = async (path: string, each: (row: any) => void) => {
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${wakatime(c)}${path}?page=${page}`, { headers: wakaHeaders(c) });
      if (!res.ok) break;
      const body = (await res.json()) as { data?: any[]; total_pages?: number };
      for (const row of body.data || []) each(row);
      if (!body.total_pages || page >= body.total_pages) break;
    }
  };
  await pages('/users/current/user_agents', (r) => {
    userAgents[r.id] = { editor: r.editor || '', os: r.os || '', ai_model: r.ai_model || '', value: r.value || '' };
  });
  await pages('/users/current/machine_names', (r) => {
    machines[r.id] = r.value || r.name || '';
  });
  return c.json({ data: { user_agents: userAgents, machines } });
});

type Row = [string, string, string, string, string, string, number, number, number];
type ImportDay = { day: string; rows: Row[]; hours: [number, number][]; ai: [string, number, number, number, number, number, number, number][] };

const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// Store daily totals the browser computed from the export.
importer.post('/days', async (c) => {
  const s = c.get('settings');
  let body: { days?: ImportDay[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const days = Array.isArray(body.days) ? body.days : [];
  if (!days.length) return c.json({ data: { stored: 0 } });
  if (days.length > MAX_DAYS_PER_REQUEST) return c.json({ error: `At most ${MAX_DAYS_PER_REQUEST} days per request` }, 400);

  const since = await ownSince(c, s);
  const lastAllowed = since ? dayOf(since, tzOf(s)) : null;
  const clean: { day: string; sum: { rows: Row[]; hours: [number, number][]; ai: ImportDay['ai'] } }[] = [];
  for (const d of days) {
    if (!isDay(d.day) || (lastAllowed && d.day > lastAllowed)) continue; // never import over Waqt's own days
    clean.push({
      day: d.day,
      sum: {
        rows: (d.rows || []).slice(0, 2000).map((r) => [str(r[0]), str(r[1], 60), str(r[2], 60), str(r[3], 40), str(r[4], 100), str(r[5], 40).toLowerCase(), num(r[6]), num(r[7]), num(r[8])] as Row),
        hours: (d.hours || []).filter((h) => Number.isInteger(h[0]) && h[0] >= 0 && h[0] < 24).map((h) => [h[0], num(h[1])] as [number, number]),
        ai: (d.ai || []).slice(0, 50).map((a) => [str(a[0], 60), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5]), num(a[6]), num(a[7])] as ImportDay['ai'][number]),
      },
    });
  }
  if (clean.length) await c.env.DB.batch(replaceDaysStatements(c.env.DB, 'import', clean));
  return c.json({ data: { stored: clean.length, skipped: days.length - clean.length } });
});

// Import finished: drop cached public stats so cards show the new history.
importer.post('/done', async (c) => {
  await clearCache(c.env);
  return c.json({ data: { ok: true } });
});

// Undo: remove everything that was imported.
importer.delete('/', async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM daily_summaries WHERE source = 'import'"),
    c.env.DB.prepare("DELETE FROM daily_hours WHERE source = 'import'"),
    c.env.DB.prepare("DELETE FROM daily_ai WHERE source = 'import'"),
  ]);
  await clearCache(c.env);
  return c.json({ data: { ok: true } });
});
