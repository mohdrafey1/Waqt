import { describe, expect, it } from 'vitest';
import { relativeEntity, summarizeDay, FILES_PER_PROJECT } from '../public/lib/core.js';
import { auth, beats, json, post } from './helpers';

describe('files and branches', () => {
  it('stores paths relative to the project folder', () => {
    expect(relativeEntity('/Users/me/code/waqt/src/index.ts', 'file', 'waqt')).toBe('src/index.ts');
    expect(relativeEntity('C:\\code\\waqt\\src\\app.js', 'file', 'waqt')).toBe('src/app.js');
    expect(relativeEntity('/a/b/c/d/e.ts', 'file', 'other')).toBe('c/d/e.ts');
    expect(relativeEntity('github.com', 'domain', 'x')).toBe('github.com');
  });

  it('keeps the busiest files and adds up the rest', () => {
    const n = FILES_PER_PROJECT + 5;
    const list = Array.from({ length: n + 1 }, (_, i) => ({
      time: 1000 + i * 60,
      project: 'p',
      language: 'Go',
      editor: 'VS Code',
      os: 'Linux',
      machine: 'm',
      category: 'coding',
      entity: `/code/p/f${i}.go`,
      type: 'file',
      branch: 'main',
    }));
    const sum = summarizeDay(list, 0, 100000, 900);
    const named = sum.files.filter((f) => f[2]);
    const other = sum.files.filter((f) => !f[2]);
    expect(named).toHaveLength(FILES_PER_PROJECT);
    expect(other).toEqual([['p', 'main', '', 5 * 60]]);
    expect(sum.files.reduce((a, f) => a + f[3], 0)).toBe(n * 60);
  });

  it('shows a project with its branches and files', async () => {
    const a = beats(6, { project: 'detail', endAgo: 58000, extra: { branch: 'main' } });
    const b = beats(4, { project: 'detail', endAgo: 56000, extra: { branch: 'feature/x' } });
    await post('/api/v1/users/current/heartbeats.bulk', [...a, ...b]);
    const { status, body } = await json('/api/v1/users/current/project?name=detail&days=7', { headers: auth });
    expect(status).toBe(200);
    const p = body.data;
    expect(p.total_seconds).toBeGreaterThan(0);
    expect(p.branches.map((x: any) => x.name).sort()).toEqual(['feature/x', 'main']);
    expect(p.files.map((x: any) => x.name)).toContain('file0.ts');
    expect(p.files.every((x: any) => !x.name.startsWith('/'))).toBe(true);
    expect(p.languages[0].name).toBe('TypeScript');
  });

  it('includes renamed projects and is private', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { project: 'old-name', endAgo: 60000 }));
    await json('/api/v1/users/current/settings', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_aliases: { 'old-name': 'new-name' } }),
    });
    const { body } = await json('/api/v1/users/current/project?name=new-name&days=7', { headers: auth });
    expect(body.data.names).toContain('old-name');
    expect(body.data.total_seconds).toBeGreaterThan(0);
    expect((await json('/api/v1/users/current/project?name=detail')).status).toBe(401);
  });
});

describe('recomputing a day', () => {
  it('writes only rows that changed', async () => {
    const { replaceDayStatements } = await import('../src/summaries');
    const { env } = await import('./helpers');
    const day = '2019-08-01';
    const sum = {
      rows: [['p', 'Go', 'Vim', 'Linux', 'm', 'coding', 120, 0, 0], ['q', 'Go', 'Vim', 'Linux', 'm', 'coding', 60, 0, 0]] as any,
      hours: [[9, 180]] as any,
      ai: [] as any,
      files: [['p', 'main', 'a.go', 120], ['q', 'main', 'b.go', 60]] as any,
    };
    const written = async (s: typeof sum) =>
      (await env.DB.batch(replaceDayStatements(env.DB, day, 'live', s))).reduce((a, r) => a + (r.meta.rows_written || 0), 0);
    expect(await written(sum)).toBeGreaterThan(0);
    expect(await written(sum)).toBe(0); // nothing changed, nothing written
    const changed = { ...sum, rows: [sum.rows[0]], files: [['p', 'main', 'a.go', 150]] as any };
    const n = await written(changed);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
    const rows = await env.DB.prepare('SELECT project, seconds FROM daily_summaries WHERE day = ?1').bind(day).all();
    expect(rows.results).toEqual([{ project: 'p', seconds: 120 }]);
    const files = await env.DB.prepare('SELECT entity, seconds FROM daily_files WHERE day = ?1').bind(day).all();
    expect(files.results).toEqual([{ entity: 'a.go', seconds: 150 }]);
  });
});
