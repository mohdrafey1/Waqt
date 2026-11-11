import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanFriends, friendEndpoints } from '../src/friends';
import { auth, json, put } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('friends leaderboard', () => {
  it('understands Waqt and WakaTime addresses', () => {
    expect(friendEndpoints('https://waqt.example.com/profile/', 'last_7_days').api).toBe('https://waqt.example.com/api/v1/users/public/stats/last_7_days');
    expect(friendEndpoints('https://x.dev/api/v1', 'last_30_days').api).toBe('https://x.dev/api/v1/users/public/stats/last_30_days');
    const w = friendEndpoints('https://wakatime.com/@alice', 'last_7_days');
    expect(w).toMatchObject({ api: 'https://wakatime.com/api/v1/users/@alice/stats/last_7_days', source: 'wakatime' });
    expect(cleanFriends([{ name: 'A', url: 'waqt.example.com/' }])).toEqual([{ name: 'A', url: 'https://waqt.example.com' }]);
    expect(cleanFriends([{ name: 'A', url: 'javascript:alert(1)' }])).toBeNull();
    expect(cleanFriends(new Array(26).fill({ name: 'x', url: 'https://a.dev' }))).toBeNull();
  });

  it('ranks friends with you, and explains the ones it can not read', async () => {
    const stats = (total: number) => new Response(JSON.stringify({ data: { total_seconds: total, daily_average: total / 7, languages: [{ name: 'Go' }, { name: 'Rust' }] } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input.url || input);
      if (url.startsWith('https://fast.test/')) return stats(999999);
      if (url.startsWith('https://wakatime.com/api/v1/users/@bob/')) return stats(3600);
      if (url.startsWith('https://private.test/')) return new Response('{"error":"private"}', { status: 403 });
      throw new Error('offline');
    });
    const saved = await put('/api/v1/users/current/settings', {
      friends: [
        { name: 'Fast', url: 'https://fast.test' },
        { name: 'Bob', url: 'https://wakatime.com/@bob' },
        { name: 'Shy', url: 'https://private.test' },
        { name: 'Gone', url: 'https://gone.test' },
      ],
    });
    expect(saved.status).toBe(200);
    const { status, body } = await json('/api/v1/users/current/friends?range=last_7_days', { headers: auth });
    expect(status).toBe(200);
    const rows = body.data.rows;
    expect(rows[0]).toMatchObject({ name: 'Fast', ok: true, languages: ['Go', 'Rust'] });
    expect(rows.some((r: any) => r.source === 'you')).toBe(true);
    expect(rows.find((r: any) => r.name === 'Shy')).toMatchObject({ ok: false, error: 'Their stats are private' });
    expect(rows[rows.length - 1].ok).toBe(false);
    await put('/api/v1/users/current/settings', { friends: [] });
  });

  it('is private', async () => {
    expect((await json('/api/v1/users/current/friends')).status).toBe(401);
  });
});
