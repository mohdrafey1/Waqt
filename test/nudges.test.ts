import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeNudge, streakEndingOn } from '../src/nudges';
import { loadSettings, saveSettings } from '../src/settings';
import { auth, beats, env, json, post, put } from './helpers';

afterEach(() => vi.restoreAllMocks());

function captureDiscord() {
  const sent: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
    sent.push({ url: String(input.url || input), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  });
  return sent;
}

describe('goal progress in the status bar', () => {
  it('shows progress toward the daily goal as one line', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(4, { project: 'sb', endAgo: 30 }));
    await put('/api/v1/users/current/settings', { goal_daily_minutes: 480, statusbar_goal: true });
    const { body } = await json('/api/v1/users/current/statusbar/today', { headers: auth });
    expect(body.data.grand_total.text).toMatch(/ · \d+% of 8 hrs$/);
    expect(body.data.categories).toHaveLength(1);
    await put('/api/v1/users/current/settings', { statusbar_goal: false });
    const plain = await json('/api/v1/users/current/statusbar/today', { headers: auth });
    expect(plain.body.data.grand_total.text).not.toContain('%');
  });
});

describe('nudges', () => {
  it('sends "goal reached" once a day', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(6, { project: 'nudge', endAgo: 20 }));
    await json('/api/v1/users/current/statusbar/today', { headers: auth }); // computes today's totals
    await saveSettings(env.DB, { goal_daily_minutes: '1', goal_weekly_hours: '0', nudge_goal: '1', report_discord: 'https://discord.test/hook', last_goal_nudge: '' });
    const sent = captureDiscord();
    const first = await maybeNudge(env, await loadSettings(env.DB));
    expect(first).toEqual(['🎯 Daily goal reached']);
    expect(sent[0].body.content).toContain('Daily goal reached');
    expect(await maybeNudge(env, await loadSettings(env.DB))).toEqual([]);
    await saveSettings(env.DB, { nudge_goal: '0', report_discord: '' });
  });

  it('counts the streak that is at risk', async () => {
    const rows = ['2019-05-01', '2019-05-02', '2019-05-03', '2019-05-05'].map((d) => [d, 'p', 'Go', 'Vim', 'Linux', 'm', 'coding', 600, 0, 0]);
    await post('/api/v1/users/current/import/days', { days: rows.map((r) => ({ day: r[0], rows: [r.slice(1)], hours: [], ai: [] })) });
    expect(await streakEndingOn(env, '2019-05-03')).toBe(3);
    expect(await streakEndingOn(env, '2019-05-05')).toBe(1);
    expect(await streakEndingOn(env, '2019-05-04')).toBe(0);
  });

  it('does nothing without a channel', async () => {
    await saveSettings(env.DB, { nudge_goal: '1', nudge_streak: '1', report_discord: '', report_telegram_token: '' });
    expect(await maybeNudge(env, await loadSettings(env.DB))).toEqual([]);
    await saveSettings(env.DB, { nudge_goal: '0', nudge_streak: '0' });
  });
});

describe('Telegram settings', () => {
  it('picks the token and chat ID out of pasted messages', async () => {
    const token = ['1234567890', 'AAH' + 'x'.repeat(32)].join(':');
    const r = await put('/api/v1/users/current/settings', {
      report_telegram_token: `Done! Use this token to access the HTTP API:\n${token}\nKeep your token secure`,
      report_telegram_chat: 'Id: 987654321\nFirst: Rafey',
    });
    expect(r.status).toBe(200);
    const s = await loadSettings(env.DB);
    expect(s.report_telegram_token).toBe(token);
    expect(s.report_telegram_chat).toBe('987654321');
    const bad = await put('/api/v1/users/current/settings', { report_telegram_token: '@rafey_waqt_bot' });
    expect(bad.status).toBe(400);
    await put('/api/v1/users/current/settings', { report_telegram_token: '', report_telegram_chat: '' });
  });
});
