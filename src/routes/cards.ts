import { Hono } from 'hono';
import { aiCard, badge, cardOptions, heatmapCard, hoursCard, messageCard, statsCard, topCard, wrappedCard } from '../cards';
import { type C, type AppEnv, cors, withSettings } from '../http';
import { getStats, streaks } from '../stats';
import { RANGES, durationText, todayIn } from '../time';
import { tzOf } from '../settings';


export const cards = new Hono<AppEnv>();
cards.use('*', withSettings);

function svg(c: C, body: string, maxAge: number) {
  c.header('Content-Type', 'image/svg+xml; charset=utf-8');
  c.header('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=86400`);
  c.header('Access-Control-Allow-Origin', '*');
  return c.body(body);
}

function cacheSeconds(c: C): number {
  const n = Number(c.req.query('cache_seconds'));
  return Number.isFinite(n) && n >= 300 ? Math.min(n, 86400) : 1800;
}

const TOP_DIMS: Record<string, string> = {
  languages: 'languages',
  editors: 'editors',
  os: 'operating_systems',
  operating_systems: 'operating_systems',
  categories: 'categories',
  projects: 'projects',
};

cards.get('/:kind', async (c) => {
  const kind = c.req.param('kind').replace(/\.svg$/, '');
  const o = cardOptions((k) => c.req.query(k));
  const s = c.get('settings');
  if (!s.public_enabled) return svg(c, messageCard('This profile is private.', o), 300);

  if (kind === 'wrapped') {
    const today = todayIn(tzOf(s));
    const year = Math.trunc(Number(c.req.query('year'))) || Number(today.slice(0, 4));
    if (year < 2000 || `${year}-01-01` > today) return svg(c, messageCard(`Nothing to show for ${year} yet.`, o), 300);
    const end = `${year}-12-31` < today ? `${year}-12-31` : today;
    const st = await getStats(c.env, s, { start: `${year}-01-01`, end, view: 'public' });
    return svg(c, wrappedCard(st!, year, o), cacheSeconds(c));
  }

  if (kind === 'heatmap') {
    const st = await getStats(c.env, s, { range: 'last_year', view: 'public' });
    return svg(c, heatmapCard(st!.days, st!.end, st!.total_seconds, o), cacheSeconds(c));
  }

  const range = c.req.query('range') || 'last_7_days';
  const st = await getStats(c.env, s, { range, view: 'public' });
  if (!st) return svg(c, messageCard(`Unknown range "${range}".`, o), 300);

  if (kind === 'hours') return svg(c, hoursCard(st, o), cacheSeconds(c));
  if (kind === 'ai') return svg(c, aiCard(st, o), cacheSeconds(c));

  if (kind === 'stats') {
    let streak = st.streak;
    if (st.range !== 'last_year' && st.range !== 'all_time') {
      const year = await getStats(c.env, s, { range: 'last_year', view: 'public' });
      if (year) streak = streaks(year.days, year.end);
    }
    return svg(c, statsCard(st, streak, o), cacheSeconds(c));
  }

  const dim = TOP_DIMS[kind];
  if (!dim) return svg(c, messageCard('Unknown card. Try languages, editors, os, categories, projects, stats, heatmap, hours, ai or wrapped.', o), 300);
  if (dim === 'projects' && !s.public_projects) {
    return svg(c, messageCard('Project names are private (turn on in Settings).', o), 300);
  }
  const count = Math.min(12, Math.max(1, Math.trunc(Number(c.req.query('count'))) || 6));
  const layout = c.req.query('layout') === 'compact' ? 'compact' : 'list';
  const hide = new Set((c.req.query('hide') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  return svg(c, topCard(st, dim, o, { count, layout, hide }), cacheSeconds(c));
});


async function badgeData(c: C) {
  const s = c.get('settings');
  const range = c.req.param('range')?.replace(/\.(svg|json)$/, '') || c.req.query('range') || 'last_7_days';
  const st = s.public_enabled ? await getStats(c.env, s, { range, view: 'public' }) : null;
  const defaultLabel = range === 'all_time' ? 'coding time' : `coding · ${(RANGES[range] || range).toLowerCase()}`;
  const label = (c.req.query('label') || defaultLabel).slice(0, 40);
  const value = !s.public_enabled ? 'private' : st ? durationText(st.total_seconds) : 'unknown range';
  const color = /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c.req.query('color') || '') ? '#' + c.req.query('color') : '#8b5cf6';
  return { label, value, color };
}

export const badges = new Hono<AppEnv>();
badges.use('*', withSettings);
badges.get('/:range', async (c) => {
  if (c.req.param('range').endsWith('.json')) {
    const b = await badgeData(c);
    cors(c);
    c.header('Cache-Control', 'public, max-age=1800');
    return c.json({ schemaVersion: 1, label: b.label, message: b.value, color: b.color.slice(1) });
  }
  const b = await badgeData(c);
  return svg(c, badge(b.label, b.value, b.color, c.req.query('style') === 'flat-square'), cacheSeconds(c));
});


