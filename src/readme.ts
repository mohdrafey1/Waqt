// Markdown stats block for profile READMEs (used by the readme-action GitHub Action).

import { Stats } from './stats';
import { durationText } from './time';

const BAR = 25;

function bar(pct: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * BAR);
  return '█'.repeat(filled) + '░'.repeat(BAR - filled);
}

function row(name: string, value: string, pct: number): string {
  const n = name.length > 24 ? name.slice(0, 23) + '…' : name;
  return `${n.padEnd(25)}${value.padEnd(20)}${bar(pct)}   ${pct.toFixed(2).padStart(5, '0')} %`;
}

function list(title: string, items: { name: string; total_seconds: number }[] | undefined, n = 5): string | null {
  items = (items || []).filter((i) => i.total_seconds >= 60);
  if (!items.length) return null;
  const total = items.reduce((a, i) => a + i.total_seconds, 0) || 1;
  return [title, ...items.slice(0, n).map((i) => row(i.name, durationText(i.total_seconds), (i.total_seconds / total) * 100))].join('\n');
}

export const README_SECTIONS = ['summary', 'languages', 'editors', 'projects', 'os', 'categories', 'hours', 'weekdays', 'ai', 'streak'];

export function renderReadme(st: Stats, sections: string[], streak: { current: number; longest: number } | null, siteUrl: string): string {
  const want = new Set(sections.length ? sections : README_SECTIONS);
  const out: string[] = [];
  const period =
    st.range === 'last_7_days' ? 'This Week' : st.range === 'last_30_days' ? 'This Month' : st.range === 'today' ? 'Today' : st.human_readable_range;

  if (want.has('summary')) {
    out.push(
      `⏱️ **${period} I Spent ${durationText(st.total_seconds)} Coding**` +
        (st.days_minus_holidays > 1 ? ` · daily average ${durationText(st.daily_average)}` : ''),
    );
    out.push('');
  }

  const blocks: string[] = [];
  if (want.has('summary')) blocks.push(`🕑︎ Time Zone: ${st.timezone}`);
  const add = (b: string | null) => b && blocks.push(b);
  if (want.has('languages')) add(list('💬 Programming Languages:', st.languages));
  if (want.has('editors')) add(list('🔥 Editors:', st.editors));
  if (want.has('projects')) add(list('🐱‍💻 Projects:', st.projects));
  if (want.has('os')) add(list('💻 Operating System:', st.operating_systems));
  if (want.has('categories')) add(list('🧭 Activity:', st.categories));
  if (blocks.length) out.push('```text', blocks.join('\n\n'), '```', '');

  if (want.has('hours') && st.dayparts.persona) {
    const total = st.dayparts.parts.reduce((a, p) => a + p.total_seconds, 0) || 1;
    out.push(`**I'm a ${st.dayparts.persona}**`, '', '```text');
    for (const p of st.dayparts.parts) out.push(row(`${p.emoji} ${p.name}`, durationText(p.total_seconds), (p.total_seconds / total) * 100));
    out.push('```', '');
  }
  if (want.has('weekdays') && st.best_weekday) {
    const order = [1, 2, 3, 4, 5, 6, 0].map((i) => st.weekdays[i]);
    const total = order.reduce((a, d) => a + d.total_seconds, 0) || 1;
    out.push(`📅 **I'm Most Productive on ${st.best_weekday}**`, '', '```text');
    for (const d of order) out.push(row(d.name, durationText(d.total_seconds), (d.total_seconds / total) * 100));
    out.push('```', '');
  }
  const a = st.ai;
  if (want.has('ai') && (a.seconds || a.ai_lines)) {
    const lines = a.ai_lines + a.human_lines;
    const fmt = (n: number) => n.toLocaleString('en-US');
    out.push(`🤖 **AI Coding ${period}**`, '', '```text');
    if (a.seconds) out.push(`⏱ AI agent time: ${durationText(a.seconds)} (${a.percent_of_time}% of coding)`);
    if (lines) out.push(`✍️ ${fmt(a.ai_lines)} lines by AI, ${fmt(a.human_lines)} by hand (${Math.round(a.ai_percent_of_lines)}% AI)`);
    if (a.input_tokens || a.output_tokens) out.push(`🔤 ${fmt(a.input_tokens)} input tokens, ${fmt(a.output_tokens)} output tokens`);
    if (a.cost && a.cost.total > 0) out.push(`💵 About ${usd(a.cost.total)} at API list prices`);
    if (a.sessions) out.push(`🧠 ${fmt(a.sessions)} session${a.sessions === 1 ? '' : 's'}, ${fmt(a.prompts)} prompt${a.prompts === 1 ? '' : 's'}`);
    if (a.models.length) {
      out.push('');
      const tot = a.models.reduce((x, m) => x + m.total_seconds, 0) || 1;
      for (const m of a.models.slice(0, 5)) out.push(row(m.name, durationText(m.total_seconds), (m.total_seconds / tot) * 100));
    }
    out.push('```', '');
  }
  if (want.has('streak') && streak && streak.current) {
    out.push(`🔥 **${streak.current}-day coding streak** (longest: ${streak.longest} day${streak.longest === 1 ? '' : 's'})`, '');
  }
  out.push(`<sub>Tracked with [Waqt](https://github.com/mohdrafey1/waqt)${siteUrl ? ` · [see more](${siteUrl}/profile/)` : ''} · updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`);
  return out.join('\n').trim() + '\n';
}

export function usd(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
}
