// SVG cards for GitHub READMEs and websites. Plain SVG + CSS, no scripts,
// so they work inside GitHub's image proxy and any <img> tag.

import { PALETTE, colorFor, isHex, mix } from './colors';
import { usd } from './readme';
import { DayTotal, Stats } from './stats';
import { addDays, durationShort, durationText, weekday } from './time';

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
const DEFAULT_ACCENT = '#8b5cf6';

interface Palette {
  bg: string;
  border: string;
  title: string;
  text: string;
  muted: string;
  track: string;
}

const LIGHT: Palette = {
  bg: '#ffffff',
  border: '#d1d9e0',
  title: '#1f2328',
  text: '#3d444d',
  muted: '#6e7781',
  track: '#eff2f5',
};
const DARK: Palette = {
  bg: '#0d1117',
  border: '#3d444d',
  title: '#f0f6fc',
  text: '#c9d1d9',
  muted: '#9198a1',
  track: '#21262d',
};

export interface CardOptions {
  theme: 'auto' | 'light' | 'dark' | 'transparent';
  accent: string;
  hideBorder: boolean;
  title?: string;
  width?: number;
}

export function cardOptions(q: (k: string) => string | undefined): CardOptions {
  const theme = q('theme');
  const accent = q('accent');
  const width = Number(q('width'));
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'transparent' ? theme : 'auto',
    accent: isHex(accent) ? '#' + accent : DEFAULT_ACCENT,
    hideBorder: q('hide_border') === 'true' || q('hide_border') === '1',
    title: q('title')?.slice(0, 80),
    width: Number.isFinite(width) && width > 0 ? width : undefined,
  };
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function levels(p: Palette, accent: string): string[] {
  return [p.track, mix(p.bg, accent, 0.3), mix(p.bg, accent, 0.55), mix(p.bg, accent, 0.8), accent];
}

function vars(p: Palette, accent: string, transparent: boolean): string {
  const l = levels(p, accent);
  return (
    `--bg:${transparent ? 'transparent' : p.bg};--bd:${transparent ? 'transparent' : p.border};` +
    `--ti:${p.title};--tx:${p.text};--mu:${p.muted};--tr:${p.track};--ac:${accent};` +
    l.map((c, i) => `--l${i}:${c};`).join('')
  );
}

function style(o: CardOptions): string {
  const t = o.theme === 'transparent';
  let css =
    o.theme === 'dark'
      ? `svg{${vars(DARK, o.accent, false)}}`
      : o.theme === 'light'
        ? `svg{${vars(LIGHT, o.accent, false)}}`
        : `svg{${vars(LIGHT, o.accent, t)}}@media (prefers-color-scheme:dark){svg{${vars(DARK, o.accent, t)}}}`;
  css +=
    `text{font-family:${FONT}}` +
    `.ti{font-size:15px;font-weight:600;fill:var(--ti)}` +
    `.sub{font-size:12px;fill:var(--mu)}` +
    `.nm{font-size:13px;fill:var(--tx)}` +
    `.val{font-size:12px;fill:var(--mu)}` +
    `.lbl{font-size:11px;fill:var(--mu);letter-spacing:.04em}` +
    `.big{font-size:19px;font-weight:600;fill:var(--ti)}` +
    `.sm{font-size:10px;fill:var(--mu)}` +
    `.tr{fill:var(--tr)}` +
    `.l0{fill:var(--l0)}.l1{fill:var(--l1)}.l2{fill:var(--l2)}.l3{fill:var(--l3)}.l4{fill:var(--l4)}`;
  return `<style>${css}</style>`;
}

function frame(o: CardOptions, w: number, h: number, body: string, label: string): string {
  const stroke = o.hideBorder ? 'none' : 'var(--bd)';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(label)}</title>${style(o)}` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="8" fill="var(--bg)" stroke="${stroke}"/>` +
    body +
    `</svg>`
  );
}

const DIM_TITLES: Record<string, string> = {
  languages: 'Top Languages',
  editors: 'Editors',
  operating_systems: 'Operating Systems',
  categories: 'Activity',
  projects: 'Top Projects',
};

/** Ranked list (languages, editors, projects...) with bars, or a compact stacked bar. */
export function topCard(
  stats: Stats,
  dim: string,
  o: CardOptions,
  opts: { count: number; layout: 'list' | 'compact'; hide: Set<string> },
): string {
  const all = ((stats as any)[dim] || []) as { name: string; total_seconds: number }[];
  const items = all.filter((i) => !opts.hide.has(i.name.toLowerCase())).slice(0, opts.count);
  const sum = items.reduce((a, i) => a + i.total_seconds, 0);
  const w = Math.min(600, Math.max(300, o.width || 360));
  const pad = 22;
  const title = o.title || DIM_TITLES[dim] || 'Coding time';
  const sub = `${stats.human_readable_range} · ${durationText(stats.total_seconds)}`;
  let body = `<text x="${pad}" y="34" class="ti">${esc(title)}</text><text x="${pad}" y="54" class="sub">${esc(sub)}</text>`;
  let h: number;

  if (!items.length) {
    body += `<text x="${pad}" y="88" class="nm">No coding activity in this range yet.</text>`;
    h = 112;
  } else if (opts.layout === 'compact') {
    const barW = w - pad * 2;
    let x = pad;
    body += `<clipPath id="c"><rect x="${pad}" y="70" width="${barW}" height="10" rx="5"/></clipPath><g clip-path="url(#c)"><rect x="${pad}" y="70" width="${barW}" height="10" class="tr"/>`;
    items.forEach((it, i) => {
      const segW = sum ? (it.total_seconds / sum) * barW : 0;
      body += `<rect x="${x.toFixed(2)}" y="70" width="${segW.toFixed(2)}" height="10" fill="${colorFor(dim, it.name, i)}"/>`;
      x += segW;
    });
    body += `</g>`;
    const colW = barW / 2;
    items.forEach((it, i) => {
      const cx = pad + (i % 2) * colW;
      const cy = 106 + Math.floor(i / 2) * 24;
      const pct = sum ? Math.round((it.total_seconds / sum) * 100) : 0;
      body +=
        `<g><circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${colorFor(dim, it.name, i)}"/>` +
        `<text x="${cx + 16}" y="${cy}" class="nm">${esc(clip(it.name, 16))} <tspan class="val">${pct}%</tspan></text></g>`;
    });
    h = 106 + Math.ceil(items.length / 2) * 24 + 6;
  } else {
    const barW = w - pad * 2;
    items.forEach((it, i) => {
      const y = 86 + i * 38;
      const pct = sum ? it.total_seconds / sum : 0;
      const color = colorFor(dim, it.name, i);
      body +=
        `<g>` +
        `<circle cx="${pad + 5}" cy="${y - 4}" r="5" fill="${color}"/>` +
        `<text x="${pad + 16}" y="${y}" class="nm">${esc(clip(it.name, 28))}</text>` +
        `<text x="${w - pad}" y="${y}" class="val" text-anchor="end">${durationShort(it.total_seconds)} · ${Math.round(pct * 100)}%</text>` +
        `<rect x="${pad}" y="${y + 8}" width="${barW}" height="6" rx="3" class="tr"/>` +
        `<rect x="${pad}" y="${y + 8}" width="${Math.max(pct * barW, 6).toFixed(2)}" height="6" rx="3" fill="${color}"/></g>`;
    });
    h = 86 + items.length * 38 + 2;
  }
  return frame(o, w, h, body, `${title}: ${sub}`);
}

/** Summary tiles: total, average, best day, streak, top language and editor. */
export function statsCard(stats: Stats, streak: { current: number; longest: number } | null, o: CardOptions): string {
  const w = Math.min(600, Math.max(360, o.width || 440));
  const pad = 22;
  const colW = (w - pad * 2) / 2;
  const title = o.title || 'Coding Stats';
  const best = stats.best_day;
  const tiles: [string, string, string][] = [
    ['TOTAL TIME', durationText(stats.total_seconds), ''],
    ['DAILY AVERAGE', durationText(stats.daily_average), `${stats.days_minus_holidays} active day${stats.days_minus_holidays === 1 ? '' : 's'}`],
    ['BEST DAY', best ? durationText(best.total_seconds) : '—', best ? best.date : ''],
    ['STREAK', streak ? `${streak.current} day${streak.current === 1 ? '' : 's'}` : '—', streak ? `longest ${streak.longest}` : ''],
    ['TOP LANGUAGE', stats.languages?.[0]?.name || '—', stats.languages?.[0] ? durationShort(stats.languages[0].total_seconds) : ''],
    ['TOP EDITOR', stats.editors?.[0]?.name || '—', stats.editors?.[0] ? durationShort(stats.editors[0].total_seconds) : ''],
  ];
  let body =
    `<text x="${pad}" y="34" class="ti">${esc(title)}</text>` +
    `<text x="${w - pad}" y="34" class="sub" text-anchor="end">${esc(stats.human_readable_range)}</text>` +
    `<rect x="${pad}" y="46" width="28" height="3" rx="1.5" fill="var(--ac)"/>`;
  tiles.forEach(([label, value, note], i) => {
    const x = pad + (i % 2) * colW;
    const y = 80 + Math.floor(i / 2) * 62;
    body +=
      `<g>` +
      `<text x="${x}" y="${y}" class="lbl">${label}</text>` +
      `<text x="${x}" y="${y + 24}" class="big">${esc(clip(value, 20))}</text>` +
      (note ? `<text x="${x}" y="${y + 40}" class="sm">${esc(note)}</text>` : '') +
      `</g>`;
  });
  return frame(o, w, 80 + 3 * 62 - 8, body, `${title}: ${durationText(stats.total_seconds)} (${stats.human_readable_range})`);
}

/** GitHub-style calendar of the last year. */
export function heatmapCard(days: DayTotal[], today: string, total: number, o: CardOptions): string {
  const cell = 11;
  const gap = 3;
  const step = cell + gap;
  const weeks = 53;
  const pad = 20;
  const left = pad + 28;
  const top = 74;
  const w = left + weeks * step - gap + pad;
  const h = top + 7 * step - gap + 42;
  const title = o.title || 'Coding Activity';

  const byDay = new Map(days.map((d) => [d.date, d.total_seconds]));
  const max = Math.max(1, ...days.map((d) => d.total_seconds));
  const start = addDays(today, -((weeks - 1) * 7 + weekday(today)));

  let cells = '';
  let months = '';
  let lastMonth = '';
  for (let wk = 0; wk < weeks; wk++) {
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, wk * 7 + d);
      if (day > today) continue;
      const secs = byDay.get(day) || 0;
      const f = secs / max;
      const lvl = secs <= 0 ? 0 : f < 0.25 ? 1 : f < 0.5 ? 2 : f < 0.75 ? 3 : 4;
      cells += `<rect x="${left + wk * step}" y="${top + d * step}" width="${cell}" height="${cell}" rx="2" class="l${lvl}"><title>${day}: ${durationText(secs)}</title></rect>`;
      if (d === 0) {
        const m = day.slice(5, 7);
        if (m !== lastMonth && wk < weeks - 1) {
          const name = new Date(day + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
          if (lastMonth || Number(day.slice(8)) <= 7) months += `<text x="${left + wk * step}" y="${top - 8}" class="sm">${name}</text>`;
          lastMonth = m;
        }
      }
    }
  }
  const dayLabels = [
    [1, 'Mon'],
    [3, 'Wed'],
    [5, 'Fri'],
  ]
    .map(([i, n]) => `<text x="${pad}" y="${top + (i as number) * step + cell - 2}" class="sm">${n}</text>`)
    .join('');
  const ly = top + 7 * step + 16;
  let legend = `<text x="${w - pad - 5 * step - 34}" y="${ly + 9}" class="sm" text-anchor="end">Less</text>`;
  for (let i = 0; i < 5; i++) legend += `<rect x="${w - pad - 5 * step - 28 + i * step}" y="${ly}" width="${cell}" height="${cell}" rx="2" class="l${i}"/>`;
  legend += `<text x="${w - pad}" y="${ly + 9}" class="sm" text-anchor="end">More</text>`;

  const body =
    `<text x="${pad}" y="32" class="ti">${esc(title)}</text>` +
    `<text x="${w - pad}" y="32" class="sub" text-anchor="end">${esc(durationText(total))} in the last year</text>` +
    months +
    dayLabels +
    cells +
    legend;
  return frame(o, w, h, body, `${title}: ${durationText(total)} in the last year`);
}

const compactNum = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

/** 24 bars for the hours of the day, plus Morning/Daytime/Evening/Night shares. */
export function hoursCard(stats: Stats, o: CardOptions): string {
  const w = Math.min(600, Math.max(360, o.width || 460));
  const pad = 22;
  const title = o.title || 'When I Code';
  const hours = stats.hours;
  const max = Math.max(1, ...hours);
  const chartTop = 70;
  const chartH = 80;
  const gap = 3;
  const bw = (w - pad * 2 - gap * 23) / 24;
  let body =
    `<text x="${pad}" y="34" class="ti">${esc(title)}</text>` +
    `<text x="${w - pad}" y="34" class="sub" text-anchor="end">${esc(stats.human_readable_range)}</text>` +
    `<text x="${pad}" y="54" class="sub">${esc(stats.dayparts.persona || 'No activity yet')}</text>`;
  hours.forEach((sec, h) => {
    const bh = Math.max(sec > 0 ? 2 : 0, (sec / max) * chartH);
    const x = pad + h * (bw + gap);
    body += `<rect x="${x.toFixed(2)}" y="${(chartTop + chartH - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="2" fill="var(--ac)" opacity="${h < 6 || h >= 18 ? 0.7 : 1}"/>`;
  });
  const axisY = chartTop + chartH + 16;
  [
    [0, '12am'],
    [6, '6am'],
    [12, '12pm'],
    [18, '6pm'],
  ].forEach(([h, t]) => {
    body += `<text x="${(pad + (h as number) * (bw + gap)).toFixed(2)}" y="${axisY}" class="sm">${t}</text>`;
  });
  const total = hours.reduce((a, b) => a + b, 0) || 1;
  const parts = stats.dayparts.parts;
  const colW = (w - pad * 2) / 4;
  parts.forEach((p, i) => {
    const x = pad + i * colW;
    body +=
      `<text x="${x}" y="${axisY + 30}" class="lbl">${p.name.toUpperCase()}</text>` +
      `<text x="${x}" y="${axisY + 50}" class="nm"><tspan style="font-weight:600;fill:var(--ti)">${Math.round((p.total_seconds / total) * 100)}%</tspan> <tspan class="val">${durationShort(p.total_seconds)}</tspan></text>`;
  });
  return frame(o, w, axisY + 66, body, `${title}: ${stats.dayparts.persona || ''}`);
}

/** AI agent time, share of lines, sessions, tokens and top models. */
export function aiCard(stats: Stats, o: CardOptions): string {
  const w = Math.min(600, Math.max(380, o.width || 460));
  const pad = 22;
  const title = o.title || 'AI Coding';
  const a = stats.ai;
  const lines = a.ai_lines + a.human_lines;
  const colW = (w - pad * 2) / 2;
  const tiles: [string, string, string][] = [
    ['AGENT TIME', durationText(a.seconds), `${a.percent_of_time}% of coding time`],
    ['LINES BY AI', lines ? `${Math.round(a.ai_percent_of_lines)}%` : '—', lines ? `${compactNum(a.ai_lines)} AI · ${compactNum(a.human_lines)} you` : ''],
    ['SESSIONS', compactNum(a.sessions), `${compactNum(a.prompts)} prompts`],
    ['TOKENS', compactNum(a.input_tokens + a.output_tokens), a.cost && a.cost.total > 0 ? `≈ ${usd(a.cost.total)} at API prices` : `${compactNum(a.input_tokens)} in · ${compactNum(a.output_tokens)} out`],
  ];
  let body =
    `<text x="${pad}" y="34" class="ti">${esc(title)}</text>` +
    `<text x="${w - pad}" y="34" class="sub" text-anchor="end">${esc(stats.human_readable_range)}</text>` +
    `<rect x="${pad}" y="46" width="28" height="3" rx="1.5" fill="var(--ac)"/>`;
  tiles.forEach(([label, value, note], i) => {
    const x = pad + (i % 2) * colW;
    const y = 80 + Math.floor(i / 2) * 62;
    body +=
      `<text x="${x}" y="${y}" class="lbl">${label}</text>` +
      `<text x="${x}" y="${y + 24}" class="big">${esc(clip(value, 18))}</text>` +
      (note ? `<text x="${x}" y="${y + 40}" class="sm">${esc(note)}</text>` : '');
  });
  let y = 80 + 2 * 62 + 4;
  if (lines) {
    const barW = w - pad * 2;
    const aiW = (a.ai_lines / lines) * barW;
    body +=
      `<clipPath id="ai"><rect x="${pad}" y="${y}" width="${barW}" height="8" rx="4"/></clipPath><g clip-path="url(#ai)">` +
      `<rect x="${pad}" y="${y}" width="${barW}" height="8" fill="#22c55e"/><rect x="${pad}" y="${y}" width="${aiW.toFixed(2)}" height="8" fill="var(--ac)"/></g>`;
    y += 26;
  }
  const models = a.models.slice(0, 3).map((m) => `${m.name} ${durationShort(m.total_seconds)}`).join(' · ');
  body += `<text x="${pad}" y="${y + 4}" class="sm">${esc(models ? 'Models: ' + clip(models, 70) : 'No AI agent activity in this range')}</text>`;
  return frame(o, w, y + 24, body, `${title}: ${durationText(a.seconds)} of agent time`);
}

// ---- shields-style badge ----

function textWidth(s: string): number {
  let wd = 0;
  for (const ch of s) {
    if ('iljI.,:;|!\'` '.includes(ch)) wd += 3.6;
    else if ('mwMW@'.includes(ch)) wd += 9.6;
    else if (/[A-Z0-9]/.test(ch)) wd += 7.5;
    else wd += 6.6;
  }
  return wd;
}

export function badge(label: string, value: string, color: string, flat: boolean): string {
  const lw = Math.round(textWidth(label) + 14);
  const vw = Math.round(textWidth(value) + 14);
  const w = lw + vw;
  const r = flat ? 0 : 3;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">` +
    `<title>${esc(label)}: ${esc(value)}</title>` +
    (flat ? '' : `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`) +
    `<clipPath id="r"><rect width="${w}" height="20" rx="${r}" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>` +
    (flat ? '' : `<rect width="${w}" height="20" fill="url(#s)"/>`) +
    `</g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>` +
    `<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text>` +
    `</g></svg>`
  );
}

export function messageCard(message: string, o: CardOptions): string {
  const w = 380;
  return frame(o, w, 70, `<text x="22" y="41" class="nm">${esc(message)}</text>`, message);
}

export { PALETTE };
