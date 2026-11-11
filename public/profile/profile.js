import { barList, compact, dailyBars, esc, fmt, heatmap, hourBars, prettyDate } from '/shared.js';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const embed = q.get('embed') === '1' || q.get('embed') === 'true';
const theme = q.get('theme');
const ALL = ['stats', 'heatmap', 'daily', 'hours', 'ai', 'languages', 'editors', 'categories', 'os', 'projects'];
const sections = new Set((q.get('sections') || (embed ? 'stats,heatmap,languages,editors' : ALL.join(','))).split(',').map((s) => s.trim()));
let range = ['last_7_days', 'last_30_days', 'last_year', 'all_time'].includes(q.get('range')) ? q.get('range') : 'last_30_days';

if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
if (embed) {
  document.body.classList.add('embed');
  document.querySelector('footer').style.marginTop = '14px';
}
document.querySelectorAll('[data-s]').forEach((el) => el.classList.toggle('hidden', !sections.has(el.dataset.s)));

function tile(label, value, note = '') {
  return `<div class="panel tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;
}

async function get(r) {
  const res = await fetch(`/api/v1/users/public/stats/${r}`);
  if (res.status === 403) throw Object.assign(new Error('private'), { private: true });
  if (!res.ok) throw new Error('Could not load stats');
  return (await res.json()).data;
}

async function load() {
  document.querySelectorAll('#ranges button').forEach((b) => b.classList.toggle('active', b.dataset.r === range));
  try {
    const [st, year] = await Promise.all([get(range), range === 'last_year' ? null : get('last_year')]);
    const y = year || st;
    const named = st.display_name && st.display_name !== st.username;
    $('#name').textContent = named ? `${st.display_name}'s coding activity` : 'Coding activity';
    document.title = `${$('#name').textContent} · Waqt`;
    $('#sub').textContent = `${fmt(st.total_seconds)} in ${st.human_readable_range.toLowerCase()}`;
    const streak = y.streak || { current: 0, longest: 0 };
    $('#tiles').innerHTML =
      tile('Total time', fmt(st.total_seconds), st.human_readable_range) +
      tile('Daily average', fmt(st.daily_average), `${st.days_minus_holidays} active days`) +
      tile('Best day', st.best_day ? fmt(st.best_day.total_seconds) : '—', st.best_day ? prettyDate(st.best_day.date, { month: 'short', day: 'numeric', year: 'numeric' }) : '') +
      tile('Streak', `${streak.current} day${streak.current === 1 ? '' : 's'}`, `Longest: ${streak.longest} days`);
    $('#heat-sub').textContent = `${fmt(y.total_seconds)} total`;
    heatmap($('#heat'), y.days, y.end);
    if (st.start !== st.end) dailyBars($('#daily'), st.days, st.start, st.end);
    hourBars($('#hours'), st.hours);
    $('#persona').textContent = st.dayparts.persona || '';
    const a = st.ai;
    const lines = a.ai_lines + a.human_lines;
    $('#ai-sub').textContent = a.seconds ? `${fmt(a.seconds)} with AI agents` : '';
    $('#ai').innerHTML = lines || a.seconds
      ? `<dl class="kv" style="margin-bottom:12px"><dt>Lines written by AI</dt><dd>${lines ? Math.round(a.ai_percent_of_lines) + '%' : '—'}</dd>
         <dt>Sessions</dt><dd>${esc(compact(a.sessions))}</dd><dt>Tokens</dt><dd>${esc(compact(a.input_tokens + a.output_tokens))}</dd></dl>
         <div class="split">${lines ? `<div style="width:${(a.ai_lines / lines) * 100}%;background:var(--accent)"></div><div style="width:${(a.human_lines / lines) * 100}%;background:#22c55e"></div>` : ''}</div>
         <div id="ai-models" style="margin-top:14px"></div>`
      : '<div class="empty">No AI activity in this range</div>';
    if ($('#ai-models')) barList($('#ai-models'), a.models.map((m) => ({ name: m.name, total_seconds: m.total_seconds })), 'models', { limit: 4 });
    for (const dim of ['languages', 'editors', 'categories', 'operating_systems']) barList($('#' + dim), st[dim], dim, { limit: 6 });
    if (st.projects) barList($('#projects'), st.projects, 'projects', { limit: 6 });
    else document.querySelector('[data-s="projects"]').classList.add('hidden');
  } catch (e) {
    if (e.private) {
      $('#content').classList.add('hidden');
      $('#ranges').classList.add('hidden');
      $('#private').classList.remove('hidden');
    } else {
      $('#sub').textContent = e.message;
    }
  }
}

document.querySelectorAll('#ranges button').forEach((b) =>
  b.addEventListener('click', () => {
    range = b.dataset.r;
    load();
  }),
);
load();
