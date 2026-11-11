import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryForwardQueue } from '../src/forward';
import { maybeSendWeekly } from '../src/report';
import { loadSettings } from '../src/settings';
import { addDays } from '../src/time';
import { auth, beats, env, json, post, put } from './helpers';

// A dummy key, built at runtime so it never looks like a real secret in the source.
const FAKE_WAKA_KEY = ['waka', '00000000-0000-4000-8000-000000000000'].join('_');
const WAKA = { WAKATIME_API_KEY: FAKE_WAKA_KEY, WAKATIME_API_URL: 'https://wakatime.test/api/v1' };
const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('.test/') && !url.includes('discord.com') && !url.includes('telegram.org')) return realFetch(input, init);
    let body: any = init.body;
    try {
      body = JSON.parse(init.body);
    } catch {}
    calls.push({ url, init, body });
    return handler(url, init);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('forwarding to WakaTime', () => {
  it('passes heartbeats on unchanged, in batches of 10', async () => {
    const calls = mockFetch(() => Response.json({ responses: [] }, { status: 202 }));
    const b = beats(23, { project: 'fwd', extra: { ai_input_tokens: 5, dependencies: ['react'] } });
    const r = await post('/api/v1/users/current/heartbeats.bulk', b, { 'X-Machine-Name': 'mbp', 'User-Agent': 'wakatime/test', Timezone: 'Asia/Kolkata' }, WAKA);
    expect(r.status).toBe(202);
    expect(calls.map((c) => c.body.length)).toEqual([10, 10, 3]);
    const first = calls[0];
    expect(first.url).toBe('https://wakatime.test/api/v1/users/current/heartbeats.bulk');
    const h = new Headers(first.init.headers);
    expect(atob(h.get('Authorization')!.slice(6))).toBe(WAKA.WAKATIME_API_KEY);
    expect(h.get('X-Machine-Name')).toBe('mbp');
    expect(h.get('Timezone')).toBe('Asia/Kolkata');
    expect(first.body[0]).toMatchObject({ ai_input_tokens: 5, dependencies: ['react'] });
  });

  it('queues failed batches and retries them later', async () => {
    let down = true;
    mockFetch(() => (down ? new Response('down', { status: 503 }) : Response.json({ responses: [] }, { status: 202 })));
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { project: 'queued' }), {}, WAKA);
    let s = (await json('/api/v1/users/current/settings', { headers: auth }, WAKA)).body.data;
    expect(s.forwarding.queued).toBeGreaterThanOrEqual(1);
    expect(s.forwarding.error).toMatch(/503/);

    down = false;
    await env.DB.prepare('UPDATE forward_queue SET next_at = 0').run(); // make it due now
    const r = await retryForwardQueue({ ...env, ...WAKA }, await loadSettings(env.DB));
    expect(r.sent).toBeGreaterThanOrEqual(1);
    s = (await json('/api/v1/users/current/settings', { headers: auth }, WAKA)).body.data;
    expect(s.forwarding.queued).toBe(0);
    expect(s.forwarding.error).toBe('');
  });

  it('drops batches WakaTime refuses as invalid', async () => {
    mockFetch(() => new Response('bad', { status: 400 }));
    await post('/api/v1/users/current/heartbeats.bulk', beats(2, { project: 'refused' }), {}, WAKA);
    const s = (await json('/api/v1/users/current/settings', { headers: auth }, WAKA)).body.data;
    expect(s.forwarding.queued).toBe(0);
  });

  it('can be switched off', async () => {
    const calls = mockFetch(() => Response.json({}, { status: 202 }));
    await put('/api/v1/users/current/settings', { forward_enabled: false });
    await post('/api/v1/users/current/heartbeats.bulk', beats(2, { project: 'off' }), {}, WAKA);
    expect(calls).toHaveLength(0);
    await put('/api/v1/users/current/settings', { forward_enabled: true });
  });
});

describe('importing WakaTime history', () => {
  it('stores days from before Waqt started, never after, and can be undone', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { project: 'live' }));
    const st = (await json('/api/v1/users/current/import/status', { headers: auth })).body.data;
    expect(st.own_since_day).toBeTruthy();
    const before = addDays(st.own_since_day, -30);
    const after = addDays(st.own_since_day, 1);
    const day = (d: string, secs: number) => ({ day: d, rows: [['old-project', 'Go', 'VS Code', 'macOS', 'mbp', 'coding', secs, 0, 0]], hours: [[10, secs]], ai: [] });

    let r = await post('/api/v1/users/current/import/days', { days: [day(before, 3600), day(after, 3600)] });
    expect(r.body.data).toEqual({ stored: 1, skipped: 1 });
    // re-importing replaces, it doesn't add
    await post('/api/v1/users/current/import/days', { days: [day(before, 7200)] });
    const all = (await json(`/api/v1/users/current/stats?start=${before}&end=${before}`, { headers: auth })).body.data;
    expect(all.total_seconds).toBe(7200);
    expect(all.hours[10]).toBe(7200);

    r = await json('/api/v1/users/current/import', { method: 'DELETE', headers: auth });
    expect(r.status).toBe(200);
    const gone = (await json(`/api/v1/users/current/stats?start=${before}&end=${before}`, { headers: auth })).body.data;
    expect(gone.total_seconds).toBe(0);
  });

  it('asks WakaTime for an export and reports progress', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/data_dumps') && init.method === 'POST') return Response.json({}, { status: 201 });
      if (url.endsWith('/data_dumps'))
        return Response.json({ data: [{ id: '1', type: 'heartbeats', status: 'Processing', percent_complete: 40, download_url: '', expires: new Date(Date.now() + 864e5).toISOString() }] });
      return new Response('nope', { status: 404 });
    });
    const r = await post('/api/v1/users/current/import/wakatime/dump', {}, {}, { WAKATIME_API_KEY: WAKA.WAKATIME_API_KEY, WAKATIME_IMPORT_URL: 'https://wakatime.test/api/v1' } as any);
    expect(r.body.data).toMatchObject({ status: 'Processing', percent: 40, ready: false });
  });
});

describe('weekly report', () => {
  it('sends to Discord and Telegram with the week summary', async () => {
    const calls = mockFetch(() => Response.json({ ok: true }));
    await post('/api/v1/users/current/heartbeats.bulk', beats(5, { project: 'reported' }));
    await put('/api/v1/users/current/settings', {
      goal_daily_minutes: 60,
      report_discord: 'https://discord.com/api/webhooks/1/abc',
      report_telegram_token: '123456789:ABCdefGhIJKlmnoPQRstuVWxyz1234567',
      report_telegram_chat: '42',
    });
    const r = (await post('/api/v1/users/current/report/test', {})).body.data;
    expect(r.sent).toEqual(['Discord', 'Telegram']);
    expect(r.preview[0]).toMatch(/Your coding week/);
    expect(calls[0].body.content).toMatch(/daily goal/);
    expect(calls[1].url).toMatch(/api\.telegram\.org\/bot123456789:.+\/sendMessage$/);
    expect(calls[1].body).toMatchObject({ chat_id: '42', parse_mode: 'HTML' });
  });

  it('goes out once, on Monday from 9:00 local time', async () => {
    const calls = mockFetch(() => Response.json({ ok: true }));
    await put('/api/v1/users/current/settings', { report_enabled: true, timezone: 'UTC', report_discord: 'https://discord.com/api/webhooks/1/abc' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:30:00Z')); // Monday 8:30
    expect(await maybeSendWeekly(env, await loadSettings(env.DB))).toBe(false);
    vi.setSystemTime(new Date('2026-11-16T09:05:00Z')); // Monday 9:05
    expect(await maybeSendWeekly(env, await loadSettings(env.DB))).toBe(true);
    expect(await maybeSendWeekly(env, await loadSettings(env.DB))).toBe(false); // only once
    vi.setSystemTime(new Date('2026-11-17T09:05:00Z')); // Tuesday
    expect(await maybeSendWeekly(env, await loadSettings(env.DB))).toBe(false);
    expect(calls.filter((c) => c.url.includes('discord')).length).toBe(1);
  });
});
