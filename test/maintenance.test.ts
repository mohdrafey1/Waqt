import { describe, expect, it } from 'vitest';
import { reparseUserAgents } from '../src/maintenance';
import { loadSettings } from '../src/settings';
import { PARSER_VERSION } from '../src/useragent';
import { auth, beats, env, json, post } from './helpers';

describe('raw user agents', () => {
  it('stores each user agent once and links heartbeats to it', async () => {
    const ua = 'wakatime/v2 (darwin-25-arm64) go1.25 opus/5-5 claude/2.1 claude-code-wakatime/3.1';
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { project: 'ua-store', endAgo: 50000, extra: { user_agent: ua } }));
    const rows = await env.DB.prepare(
      "SELECT h.editor, h.ai_model, u.value FROM heartbeats h JOIN user_agents u ON u.id = h.user_agent_id WHERE h.project = 'ua-store'",
    ).all<{ editor: string; ai_model: string; value: string }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results[0]).toMatchObject({ editor: 'Claude Code', ai_model: 'Opus 5.5', value: ua });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_agents WHERE value = ?1').bind(ua).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('re-reads stored heartbeats when the parser improves, writing only rows that change', async () => {
    const ua = 'wakatime/v2 (darwin-25-arm64) go1.25 sonnet/unknown claude/2.1 claude-code-wakatime/3.1';
    await post('/api/v1/users/current/heartbeats.bulk', beats(4, { project: 'ua-fix', endAgo: 52000, extra: { user_agent: ua } }));
    // Simulate what an older parser stored.
    await env.DB.prepare("UPDATE heartbeats SET editor = 'Sonnet', ai_model = '' WHERE project = 'ua-fix'").run();
    const changed = await reparseUserAgents(env, await loadSettings(env.DB));
    expect(changed).toBe(4);
    const r = await env.DB.prepare("SELECT DISTINCT editor, ai_model FROM heartbeats WHERE project = 'ua-fix'").all();
    expect(r.results).toEqual([{ editor: 'Claude Code', ai_model: 'Sonnet' }]);
    expect((await loadSettings(env.DB)).parser_version).toBe(PARSER_VERSION);
    // Nothing left to change the second time.
    expect(await reparseUserAgents(env, await loadSettings(env.DB))).toBe(0);
  });
});

describe('older heartbeats without a raw user agent', () => {
  it('get their AI model name tidied', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { project: 'no-ua', endAgo: 68000 }));
    await env.DB.prepare("UPDATE heartbeats SET user_agent_id = NULL, ai_model = 'Opus 5-5' WHERE project = 'no-ua'").run();
    expect(await reparseUserAgents(env, await loadSettings(env.DB))).toBeGreaterThanOrEqual(3);
    const r = await env.DB.prepare("SELECT DISTINCT ai_model FROM heartbeats WHERE project = 'no-ua'").all();
    expect(r.results).toEqual([{ ai_model: 'Opus 5.5' }]);
  });
});

describe('free plan usage meter', () => {
  it('counts requests and database rows', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(5, { project: 'usage', endAgo: 54000 }));
    const { status, body } = await json('/api/v1/users/current/usage', { headers: auth });
    expect(status).toBe(200);
    const u = body.data;
    expect(u.today.requests).toBeGreaterThan(0);
    expect(u.today.rows_written).toBeGreaterThan(0);
    expect(u.today.rows_read).toBeGreaterThan(0);
    expect(u.limits.rows_written).toBe(100000);
    expect(u.raw_heartbeats).toBeGreaterThan(0);
  });

  it('is private', async () => {
    expect((await json('/api/v1/users/current/usage')).status).toBe(401);
  });
});

describe('reading costs', () => {
  const reads = async () => (await json('/api/v1/users/current/usage', { headers: auth })).body.data.today.rows_read as number;
  const cost = async (path: string) => {
    const a = await reads();
    const b = await reads();
    await json(path, { headers: auth });
    return (await reads()) - b - (b - a);
  };

  it('keeps big views cheap on the free plan', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const days = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.parse(today) - (i + 400) * 864e5).toISOString().slice(0, 10);
      return { day: d, rows: Array.from({ length: 10 }, (_, k) => [`p${k}`, 'Go', 'Vim', 'Linux', 'm', 'coding', 60, 0, 0]), hours: [[9, 600]], ai: [] };
    });
    await post('/api/v1/users/current/import/days', { days: days.slice(0, 50) });
    await post('/api/v1/users/current/import/days', { days: days.slice(50) });
    const rows = 100 * 10;
    // A long range reads each row a few times at most, then comes from the cache.
    const first = await cost('/api/v1/users/current/stats/all_time');
    expect(first).toBeLessThan(rows * 6);
    expect(await cost('/api/v1/users/current/stats/all_time')).toBeLessThan(50);
    // Pages opened all the time read a handful of rows, not whole tables.
    expect(await cost('/api/v1/users/current/settings')).toBeLessThan(50);
    expect(await cost('/api/v1/users/current/backup')).toBeLessThan(50);
    await cost('/api/v1/users/current/import/status');
    expect(await cost('/api/v1/users/current/import/status')).toBeLessThan(50);
  });
});
