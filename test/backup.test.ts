import { describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../public/lib/backup.js';
import { loadSettings } from '../src/settings';
import { auth, beats, env, json, post, put } from './helpers';

const api = async (path: string, opts: RequestInit = {}) => {
  const { status, body } = await json('/api/v1' + path, { ...opts, headers: { ...auth, 'Content-Type': 'application/json' } });
  if (status >= 400) throw new Error(body.error || String(status));
  return body;
};

const snapshot = async () => {
  const out: Record<string, unknown[]> = {};
  for (const t of ['daily_summaries', 'daily_hours', 'daily_ai', 'daily_files']) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`).all()).results;
  }
  return out;
};

describe('backups', () => {
  it('backs up every daily table and restores it exactly', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(8, { project: 'bk', endAgo: 62000, extra: { branch: 'main' } }));
    await post('/api/v1/users/current/import/days', {
      days: [{ day: '2024-03-01', rows: [['old', 'Go', 'VS Code', 'Linux', 'm', 'coding', 3600, 0, 0]], hours: [[9, 3600]], ai: [], files: [['old', 'main', 'main.go', 3600]] }],
    });
    await put('/api/v1/users/current/settings', { display_name: 'Backup Test', goal_daily_minutes: 90 });
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_discord', 'https://discord.test/secret') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await api('/users/current/stats/last_7_days'); // make sure today's totals are computed

    const before = await snapshot();
    const backup = await createBackup(api);
    expect(backup.format).toBe('waqt-backup');
    expect(backup.first_day).toBe('2024-03-01');
    expect(backup.settings.display_name).toBe('Backup Test');
    expect(backup.settings.report_discord).toBeUndefined(); // secrets stay out
    expect(backup.tables.daily_files.rows.length).toBeGreaterThan(0);

    // Lose everything, then restore.
    for (const t of Object.keys(before)) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await put('/api/v1/users/current/settings', { display_name: 'Changed' });
    const r = await restoreBackup(api, JSON.parse(JSON.stringify(backup)));
    expect(r.days).toBeGreaterThan(1);
    expect(await snapshot()).toEqual(before);
    const s = await loadSettings(env.DB);
    expect(s.display_name).toBe('Backup Test');
    expect(s.goal_daily_minutes).toBe(90);
    expect(s.report_discord).toBe('https://discord.test/secret'); // left alone
  });

  it('protects restored days without raw heartbeats from being rebuilt', async () => {
    await api('/users/current/backup/restore', {
      method: 'POST',
      body: JSON.stringify({
        tables: { daily_summaries: { columns: ['day', 'source', 'project', 'language', 'editor', 'os', 'machine', 'category', 'seconds'], rows: [['2020-01-02', 'live', 'r', 'Go', 'Vim', 'Linux', 'm', 'coding', 120]] } },
      }),
    });
    await api('/users/current/backup/restore/done', { method: 'POST', body: '{}' });
    const s = await loadSettings(env.DB);
    expect(s.raw_since).toBeGreaterThan(Date.parse('2020-01-03T00:00:00Z') / 1000);
  });

  it('rejects bad input and is private', async () => {
    expect((await json('/api/v1/users/current/backup')).status).toBe(401);
    const bad = await json('/api/v1/users/current/backup/days?from=2024-01-01&to=2025-01-01', { headers: auth });
    expect(bad.status).toBe(400);
    await expect(restoreBackup(api, { format: 'nope' })).rejects.toThrow('not a Waqt backup');
  });
});
