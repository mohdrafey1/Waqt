import { describe, expect, it } from 'vitest';
import { KEY, auth, beats, call, cron, env, json, post, put } from './helpers';

describe('auth', () => {
  it('rejects requests without the key', async () => {
    const r = await post('/api/v1/users/current/heartbeats.bulk', [], { Authorization: '' });
    expect(r.status).toBe(401);
    expect((await json('/api/v1/users/current/stats')).status).toBe(401);
  });

  it('accepts the key the way the WakaTime CLI sends it, plus Bearer and waka_ prefix', async () => {
    for (const h of ['Basic ' + btoa(KEY), 'Basic ' + btoa(KEY + ':'), 'Bearer ' + KEY, 'Basic ' + btoa('waka_' + KEY)]) {
      expect((await json('/api/v1/users/current/stats', { headers: { Authorization: h } })).status).toBe(200);
    }
  });

  it('explains when API_KEY is missing', async () => {
    const r = await json('/api/v1/users/current/statusbar/today', { headers: auth }, { API_KEY: '' });
    expect(r.status).toBe(500);
    const s = await post('/api/v1/users/current/heartbeats.bulk', [], {}, { API_KEY: 'not-a-uuid' });
    expect(s.body.error).toMatch(/API_KEY/);
  });
});

describe('heartbeats and stats', () => {
  it('stores heartbeats in the format the CLI expects and counts time', async () => {
    const r = await post('/api/v1/users/current/heartbeats.bulk', [...beats(11, { project: 'alpha' }), { nope: true }], { 'X-Machine-Name': 'laptop', Timezone: 'UTC' });
    expect(r.status).toBe(202);
    expect(r.body.responses).toHaveLength(12);
    expect(r.body.responses[0][1]).toBe(201);
    expect(r.body.responses[11][1]).toBe(400);

    const st = (await json('/api/v1/users/current/stats/last_7_days', { headers: auth })).body.data;
    const alpha = st.projects.find((p: any) => p.name === 'alpha');
    expect(alpha.total_seconds).toBe(1200); // 10 gaps of 2 minutes
    expect(st.editors[0].name).toBe('VS Code');
    expect(st.machines.map((m: any) => m.name)).toContain('laptop');
    expect(st.hours.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(1200);
  });

  it('ignores duplicate heartbeats (CLI retries)', async () => {
    const b = beats(6, { project: 'dupes', endAgo: 4000 });
    await post('/api/v1/users/current/heartbeats.bulk', b);
    await post('/api/v1/users/current/heartbeats.bulk', b);
    const st = (await json('/api/v1/users/current/stats/last_7_days', { headers: auth })).body.data;
    expect(st.projects.find((p: any) => p.name === 'dupes').total_seconds).toBe(600);
  });

  it('resolves <<LAST_LANGUAGE>> to the language last used in the project', async () => {
    const b = beats(4, { project: 'browser', endAgo: 40000 });
    b[0].language = 'Rust';
    b[1].language = '<<LAST_LANGUAGE>>';
    b[2].language = '<<LAST_LANGUAGE>>';
    await post('/api/v1/users/current/heartbeats.bulk', b.slice(0, 2));
    await post('/api/v1/users/current/heartbeats.bulk', b.slice(2)); // resolved from the database
    const st = (await json('/api/v1/users/current/stats/last_7_days', { headers: auth })).body.data;
    expect(st.languages.map((l: any) => l.name)).not.toContain('<<LAST_LANGUAGE>>');
    const { results } = await env.DB.prepare("SELECT language FROM heartbeats WHERE project = 'browser' ORDER BY time").all<{ language: string }>();
    expect(results.map((r) => r.language)).toEqual(['Rust', 'Rust', 'Rust', 'TypeScript']);
  });

  it('answers the editor status bar', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(4, { project: 'status' }));
    const r = await json('/api/v1/users/current/statusbar/today', { headers: auth });
    expect(r.status).toBe(200);
    expect(r.body.data.grand_total.text).toMatch(/min|hr/);
    expect(r.body.data.range.text).toBe('Today');
  });

  it('keeps private things out of the public view', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(5, { project: 'secret' }));
    const pub = (await json('/api/v1/users/anyone/stats/last_7_days')).body.data;
    expect(pub.machines).toBeUndefined();
    expect(pub.projects).toBeUndefined();
    expect(pub.labels).toBeUndefined();

    await put('/api/v1/users/current/settings', { public_projects: true, hidden_projects: ['secret'] });
    const pub2 = (await json('/api/v1/users/anyone/stats/last_7_days')).body.data;
    expect(pub2.projects.map((p: any) => p.name)).not.toContain('secret');

    await put('/api/v1/users/current/settings', { public_enabled: false });
    expect((await json('/api/v1/users/anyone/stats')).status).toBe(403);
    await put('/api/v1/users/current/settings', { public_enabled: true, public_projects: false, hidden_projects: [] });
  });

  it('applies renames, merges and labels', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', [...beats(3, { project: 'old-a', endAgo: 9000 }), ...beats(3, { project: 'old-b', endAgo: 7000 })]);
    await put('/api/v1/users/current/settings', { project_aliases: { 'old-a': 'merged', 'old-b': 'merged' }, project_labels: { merged: 'Client X' } });
    const st = (await json('/api/v1/users/current/stats/last_7_days', { headers: auth })).body.data;
    expect(st.projects.find((p: any) => p.name === 'merged').total_seconds).toBe(480);
    expect(st.labels.find((l: any) => l.name === 'Client X').total_seconds).toBe(480);
    const projects = (await json('/api/v1/users/current/projects', { headers: auth })).body.data.map((p: any) => p.name);
    expect(projects).toEqual(expect.arrayContaining(['old-a', 'old-b']));
  });

  it('validates settings', async () => {
    const r = await put('/api/v1/users/current/settings', { timezone: 'Mars/Base', raw_retention_days: 5, report_discord: 'https://evil.example/x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/timezone/);
    expect(r.body.error).toMatch(/raw_retention_days/);
    expect(r.body.error).toMatch(/Discord/);
  });

  it('never returns saved report secrets', async () => {
    await put('/api/v1/users/current/settings', { report_telegram_token: '123456789:ABCdefGhIJKlmnoPQRstuVWxyz1234567', report_telegram_chat: '42' });
    const s = (await json('/api/v1/users/current/settings', { headers: auth })).body.data;
    expect(JSON.stringify(s)).not.toContain('ABCdef');
    expect(s.report_telegram_set).toBe(true);
  });

  it('serves per-day summaries and timesheets', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(4, { project: 'billable', endAgo: 20000 }));
    const sum = (await json('/api/v1/users/current/summaries?range=last_7_days', { headers: auth })).body;
    expect(sum.data).toHaveLength(7);
    const ts = (await json(`/api/v1/users/current/timesheet?start=${sum.start}&end=${sum.end}`, { headers: auth })).body.data;
    const billable = ts.rows.filter((r: any) => r.project === 'billable').reduce((a: number, r: any) => a + r.seconds, 0);
    expect(billable).toBe(360);
  });

  it('works with the github-readme-stats wakatime card shape', async () => {
    const st = (await json('/api/v1/users/rafey/stats?is_including_today=true')).body.data;
    expect(st.range).toBe('last_7_days');
    expect(st.is_coding_activity_visible).toBe(true);
    for (const l of st.languages) expect(l).toMatchObject({ name: expect.any(String), percent: expect.any(Number), text: expect.any(String) });
  });
});

describe('cards, badges and README block', () => {
  it('renders SVG cards', async () => {
    for (const kind of ['languages', 'editors', 'stats', 'heatmap', 'hours', 'ai']) {
      const res = await call(`/card/${kind}.svg?theme=dark`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toMatch(/image\/svg\+xml/);
      const svg = await res.text();
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toMatch(/<script/i);
    }
  });

  it('escapes names in cards', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { language: '<script>x</script>', project: 'xss', endAgo: 30000 }));
    await put('/api/v1/users/current/settings', { display_name: 'x' }); // clears the public cache
    const svg = await (await call('/card/languages.svg?range=last_7_days&count=12')).text();
    expect(svg).not.toContain('<script>x');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('serves badges and a Shields.io endpoint', async () => {
    expect((await call('/badge/last_7_days.svg')).headers.get('Content-Type')).toMatch(/svg/);
    const j = (await json('/badge/today.json')).body;
    expect(j).toMatchObject({ schemaVersion: 1, label: expect.any(String), message: expect.any(String) });
  });

  it('renders the README markdown block', async () => {
    const res = await call('/api/v1/users/current/readme.md?range=last_7_days&sections=summary,languages', { headers: auth });
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toMatch(/I Spent .* Coding/);
    expect(md).toContain('```text');
  });
});

describe('cron', () => {
  it('rebuilds days and keeps up with pending work', async () => {
    await post('/api/v1/users/current/heartbeats.bulk', beats(3, { project: 'cron' }));
    await cron();
    const s = (await json('/api/v1/users/current/settings', { headers: auth })).body.data;
    expect(s.stats.pending_days).toBe(0);
  });
});

describe('Waqt Wrapped', () => {
  it('draws the year card and the page is served', async () => {
    const year = new Date().getUTCFullYear();
    const res = await call(`/card/wrapped.svg?year=${year}&theme=dark`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain(`${year} in code`);
    expect(svg).toContain('LONGEST STREAK');
    const future = await (await call(`/card/wrapped.svg?year=${year + 1}`)).text();
    expect(future).toContain('Nothing to show');
  });
});
