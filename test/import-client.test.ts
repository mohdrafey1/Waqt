import { describe, expect, it } from 'vitest';
import { runImport } from '../public/import.js';

const UA = 'wakatime/v1.90 (darwin-24-arm64) go1.22 vscode/1.95 vscode-wakatime/24.0';
const t = (iso: string) => Date.parse(iso) / 1000;
const session = (startIso: string, n: number, project: string) =>
  Array.from({ length: n }, (_, i) => ({
    time: t(startIso) + i * 120,
    entity: `/code/${project}/f${i % 4}.ts`,
    type: 'file',
    category: 'coding',
    project,
    language: 'TypeScript',
    user_agent_id: 'ua1',
    machine_name_id: 'm1',
  }));

describe('importing in the browser', () => {
  it("fills the days between an old export and Waqt's first heartbeat", async () => {
    const dump = { days: [{ date: '2026-01-10', heartbeats: session('2026-01-10T09:00:00Z', 31, 'old') }] };
    const uploaded: any[] = [];
    const api = async (path: string, opts: any = {}) => {
      if (path === '/users/current/import/status')
        return { data: { wakatime_key: true, own_since: t('2026-01-20T12:00:00Z'), timezone: 'UTC', timeout_minutes: 15 } };
      if (path === '/users/current/import/wakatime/lookups')
        return { data: { user_agents: { ua1: { value: UA, editor: 'VS Code', os: 'Mac', ai_model: '' } }, machines: { m1: 'mbp' } } };
      if (path.startsWith('/users/current/import/wakatime/day?date=')) {
        const date = path.split('=')[1];
        if (date === '2026-01-17') throw new Error('WakaTime answered 429');
        if (date === '2026-01-15') return { data: session('2026-01-15T10:00:00Z', 16, 'recent') };
        if (date === '2026-01-20') return { data: [...session('2026-01-20T08:00:00Z', 6, 'recent'), ...session('2026-01-20T13:00:00Z', 6, 'after')] };
        return { data: [] };
      }
      if (path === '/users/current/import/days') {
        const days = JSON.parse(opts.body).days;
        uploaded.push(...days);
        return { data: { stored: days.length } };
      }
      return { data: {} };
    };
    const file = new File([JSON.stringify(dump)], 'export.json');
    const r = await runImport({ api, file, onStatus: () => {} });

    const byDay = Object.fromEntries(uploaded.map((d) => [d.day, d.rows.reduce((a: number, row: any[]) => a + row[6], 0)]));
    expect(Object.keys(byDay).sort()).toEqual(['2026-01-10', '2026-01-15', '2026-01-20']);
    expect(byDay['2026-01-10']).toBe(30 * 120);
    expect(byDay['2026-01-15']).toBe(15 * 120);
    expect(byDay['2026-01-20']).toBe(5 * 120); // nothing from after Waqt's first heartbeat
    expect(uploaded.find((d) => d.day === '2026-01-15').rows[0][2]).toBe('VS Code');
    expect(r.export_end).toBe('2026-01-10');
    expect(r.filled_days).toBeGreaterThan(5);
    expect(r.missing_days).toEqual(['2026-01-17']);
  });

  it("doesn't take a browser's \"Mozilla\" for an AI model", async () => {
    const browserUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 chrome-wakatime/4.0';
    const hb = session('2026-01-10T09:00:00Z', 6, 'web').map((h) => ({ ...h, category: 'ai coding', user_agent_id: 'b1' }));
    const uploaded: any[] = [];
    const api = async (path: string, opts: any = {}) => {
      if (path === '/users/current/import/status') return { data: { wakatime_key: false, own_since: t('2026-01-11T00:00:00Z'), timezone: 'UTC', timeout_minutes: 15 } };
      if (path === '/users/current/import/wakatime/lookups')
        return { data: { user_agents: { b1: { value: browserUa, editor: 'AppleWebKit', os: 'Mac', ai_model: 'Mozilla' } }, machines: {} } };
      if (path === '/users/current/import/days') {
        uploaded.push(...JSON.parse(opts.body).days);
        return { data: { stored: 1 } };
      }
      return { data: {} };
    };
    await runImport({ api, file: new File([JSON.stringify({ days: [{ heartbeats: hb }] })], 'x.json'), onStatus: () => {} });
    expect(uploaded[0].rows[0][2]).toBe('Chrome');
    expect(uploaded[0].rows[0][3]).toBe('macOS');
    expect(uploaded[0].ai.map((a: any[]) => a[0])).toEqual(['']);
  });
});
