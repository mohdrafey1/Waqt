import { runImport } from './import.js';
import { createBackup, restoreBackup } from './lib/backup.js';
import { LOGO, addDays, barList, compact, copy, dailyBars, esc, fmt, heatmap, hourBars, prettyDate, toast, weekdayBars } from './shared.js';

const $ = (s) => document.querySelector(s);
const origin = location.origin;
const host = location.host;
let newKey = ''; // a device key just created in Setup (shown once)
let settings = null;

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
  return null;
}

// Signed in with an HttpOnly session cookie; X-Waqt proves the request comes from this page.
const AUTH_HEADERS = { 'X-Waqt': '1' };
async function api(path, opts = {}) {
  const res = await fetch('/api/v1' + path, {
    ...opts,
    credentials: 'same-origin',
    headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------- login ----------
$('#login-logo').innerHTML = LOGO + '<span>Waqt</span>';
$('#app-logo').innerHTML = LOGO + '<span>Waqt</span>';

async function loadSettings() {
  try {
    settings = (await api('/users/current/settings')).data;
    return true;
  } catch (e) {
    if (e.status === 401 || e.status === 403) return false;
    throw e;
  }
}

async function signIn(secret) {
  await api('/auth/login', { method: 'POST', body: JSON.stringify({ secret }) });
  return loadSettings();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    if (await signIn($('#login-key').value)) start();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

$('#logout').onclick = async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab)),
);
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  $('#range').classList.toggle('hidden', name !== 'overview' && name !== 'ai');
  history.replaceState(null, '', name === 'overview' ? '#' : '#' + name);
  if (name === 'share') renderShare();
  if (name === 'projects') renderProjects();
  if (name === 'friends') renderFriends();
  if (name === 'ai') loadAi();
  if (name === 'timesheets') loadTimesheet();
  if (name === 'setup') {
    renderSetup();
    renderUsage();
    renderInspector();
    renderBackup();
    renderImport();
  }
  if (name === 'settings') renderSettings();
}

// ---------- overview ----------
$('#range').addEventListener('change', () => {
  store('waqt_range', $('#range').value);
  if (!$('[data-view="ai"]').classList.contains('hidden')) loadAi();
  else loadOverview();
});

function tile(label, value, note = '') {
  return `<div class="panel tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;
}

async function loadOverview() {
  const range = $('#range').value;
  const [{ data: st }, { data: year }] = await Promise.all([
    api(`/users/current/stats/${range}`),
    api('/users/current/stats/last_year'),
  ]);
  const streak = year.streak || { current: 0, longest: 0 };
  const lines = st.ai_lines + st.human_lines;
  $('#tiles').innerHTML =
    tile('Total time', fmt(st.total_seconds), st.human_readable_range) +
    tile('Daily average', fmt(st.daily_average), `${st.days_minus_holidays} active day${st.days_minus_holidays === 1 ? '' : 's'}`) +
    tile('Best day', st.best_day ? fmt(st.best_day.total_seconds) : '—', st.best_day ? prettyDate(st.best_day.date, { weekday: 'short', month: 'short', day: 'numeric' }) : '') +
    tile('Streak', `${streak.current} day${streak.current === 1 ? '' : 's'}`, `Longest: ${streak.longest} days`) +
    (lines > 0
      ? tile('AI share of lines', `${Math.round((st.ai_lines / lines) * 100)}%`, `${st.ai_lines.toLocaleString()} AI · ${st.human_lines.toLocaleString()} you`)
      : tile('Top language', st.languages[0]?.name || '—', st.languages[0] ? fmt(st.languages[0].total_seconds) : ''));

  renderGoals(year);
  hourBars($('#hours'), st.hours);
  weekdayBars($('#weekdays'), st.weekdays);
  $('#persona').textContent = st.dayparts.persona || '';
  $('#best-weekday').textContent = st.best_weekday ? `Most productive on ${st.best_weekday}` : '';
  const multiDay = st.start !== st.end;
  $('#daily-panel').classList.toggle('hidden', !multiDay);
  if (multiDay) {
    $('#daily-sub').textContent = `${prettyDate(st.start)} – ${prettyDate(st.end)}`;
    dailyBars($('#daily'), st.days, st.start, st.end);
  }
  $('#heat-sub').textContent = `${fmt(year.total_seconds)} · ${year.days_minus_holidays} active days`;
  heatmap($('#heat'), year.days, year.end);
  for (const dim of ['projects', 'languages', 'editors', 'categories', 'operating_systems', 'machines']) {
    barList($('#' + dim), st[dim], dim);
  }
  const labelled = (st.labels || []).some((l) => l.name !== 'No label');
  $('#labels-panel').classList.toggle('hidden', !labelled);
  if (labelled) barList($('#labels'), st.labels, 'labels');
  if (st.total_seconds === 0 && year.total_seconds === 0) {
    $('#notice').innerHTML = `<div class="banner"><b>No activity yet.</b> Head to <a href="#setup" id="go-setup">Setup</a> to connect your editor. It takes about a minute.</div>`;
    $('#go-setup').onclick = (e) => {
      e.preventDefault();
      showTab('setup');
    };
  } else {
    $('#notice').innerHTML =
      (await usageWarning()) +
      (settings.update_available && store('waqt_seen_version') !== settings.latest_version
        ? `<div class="banner" style="border-left-color:var(--accent)"><b>Waqt ${esc(settings.latest_version)} is out.</b> <a href="${esc(settings.changelog)}" target="_blank" rel="noopener">See what's new</a>, then run <i>Update Waqt</i> in your GitHub copy's Actions tab. <a href="#" id="dismiss-update">Dismiss</a></div>`
        : '');
    const dismiss = $('#dismiss-update');
    if (dismiss) dismiss.onclick = (e) => (e.preventDefault(), store('waqt_seen_version', settings.latest_version), loadOverview());
    document.querySelectorAll('.go-setup').forEach((a) => (a.onclick = (e) => (e.preventDefault(), showTab('setup'))));
  }
}

// ---------- AI ----------
async function loadAi() {
  const { data: st } = await api(`/users/current/stats/${$('#range').value}`);
  const a = st.ai;
  const lines = a.ai_lines + a.human_lines;
  $('#ai-tiles').innerHTML =
    tile('AI agent time', fmt(a.seconds), `${a.percent_of_time}% of your coding time`) +
    tile('Lines by AI', lines ? `${Math.round(a.ai_percent_of_lines)}%` : '—', `${compact(a.ai_lines)} AI · ${compact(a.human_lines)} you`) +
    tile('Sessions', compact(a.sessions), `${compact(a.prompts)} prompts`) +
    tile('Tokens', compact(a.input_tokens + a.output_tokens), `${compact(a.input_tokens)} in · ${compact(a.output_tokens)} out · ${compact(a.cached_tokens)} cached`) +
    tile('Top model', a.models[0]?.name || '—', a.models[0] ? fmt(a.models[0].total_seconds) : '') +
    (a.cost ? tile('API cost estimate', usd(a.cost.total), a.cost.unpriced_tokens ? `${compact(a.cost.unpriced_tokens)} tokens not priced` : 'at list prices') : '');
  drawCost(a);
  $('#ai-split').innerHTML = lines
    ? `<div style="width:${(a.ai_lines / lines) * 100}%;background:var(--accent)"></div><div style="width:${(a.human_lines / lines) * 100}%;background:#22c55e"></div>`
    : '';
  $('#ai-split-text').textContent = lines ? `${a.ai_lines.toLocaleString()} by AI · ${a.human_lines.toLocaleString()} by you` : 'No line data in this range';
  if (st.start !== st.end) dailyBars($('#ai-daily'), a.days, st.start, st.end);
  else $('#ai-daily').innerHTML = `<div class="empty">${esc(fmt(a.seconds))} today</div>`;
  barList(
    $('#ai-models'),
    a.models.map((m) => ({ name: m.name, total_seconds: m.total_seconds })),
    'models',
  );
}

// ---------- AI cost estimate ----------
const usd = (n) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
let prices = null; // rows being edited
function drawCost(a) {
  if (!prices) prices = (settings.ai_prices || []).map((p) => [...p]);
  $('#ai-cost-public').checked = !!settings.ai_cost_public;
  $('#ai-cost-sub').textContent = a.cost ? `${usd(a.cost.total)} in this range` : '';
  const withTokens = a.models.filter((m) => m.input_tokens || m.output_tokens || m.cached_tokens);
  $('#ai-cost-models').innerHTML = withTokens.length
    ? `<table class="table"><thead><tr><th>Model</th><th style="text-align:right">Input</th><th style="text-align:right">Output</th><th style="text-align:right">Cached</th><th style="text-align:right">Estimate</th></tr></thead><tbody>${withTokens
        .map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${compact(m.input_tokens)}</td><td class="num">${compact(m.output_tokens)}</td><td class="num">${compact(m.cached_tokens)}</td><td class="num">${m.cost == null ? '<span class="faint">no price</span>' : usd(m.cost)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<div class="empty">No token counts in this range. Tokens come from plugins that report them, such as Claude Code.</div>';
  drawPrices();
}
function drawPrices() {
  $('#price-table tbody').innerHTML = prices
    .map(
      (p, i) => `<tr data-i="${i}">
        <td><input type="text" class="pr-name" value="${esc(p[0])}" maxlength="60" placeholder="e.g. Opus 5.5"></td>
        ${[1, 2, 3].map((k) => `<td class="num"><input type="number" class="pr-${k}" value="${p[k]}" min="0" step="0.01"></td>`).join('')}
        <td style="text-align:right"><button class="btn small pr-del" type="button" title="Remove">✕</button></td>
      </tr>`,
    )
    .join('');
  document.querySelectorAll('#price-table tbody tr').forEach((tr) => {
    const i = Number(tr.dataset.i);
    tr.querySelector('.pr-name').oninput = (e) => (prices[i][0] = e.target.value);
    [1, 2, 3].forEach((k) => (tr.querySelector('.pr-' + k).oninput = (e) => (prices[i][k] = Number(e.target.value))));
    tr.querySelector('.pr-del').onclick = () => {
      prices.splice(i, 1);
      drawPrices();
    };
  });
}
async function savePrices(body) {
  $('#price-err').textContent = '';
  try {
    const { data } = await api('/users/current/settings', { method: 'PUT', body: JSON.stringify(body) });
    settings = { ...settings, ...data };
    prices = null;
    toast('Prices saved');
    loadAi();
  } catch (e) {
    $('#price-err').textContent = e.message;
  }
}
$('#price-add').onclick = () => {
  prices.push(['', 0, 0, 0]);
  drawPrices();
  document.querySelector('#price-table tbody tr:last-child .pr-name').focus();
};
$('#price-save').onclick = () =>
  savePrices({ ai_prices: prices.filter((p) => p[0].trim()), ai_cost_public: $('#ai-cost-public').checked });
$('#price-reset').onclick = () => {
  if (window.confirm('Go back to the built-in prices?')) savePrices({ ai_prices: null, ai_cost_public: $('#ai-cost-public').checked });
};

// ---------- goals ----------
function renderGoals(year) {
  const g = year.goals || {};
  const box = $('#goals');
  if (!g.daily_minutes && !g.weekly_hours) {
    box.classList.add('hidden');
    return;
  }
  const today = year.end;
  const byDay = new Map(year.days.map((d) => [d.date, d.total_seconds]));
  const wd = new Date(today + 'T00:00:00Z').getUTCDay();
  const monday = addDays(today, -((wd + 6) % 7));
  let week = 0;
  for (let d = monday; d <= today; d = addDays(d, 1)) week += byDay.get(d) || 0;
  const card = (title, done, goal) => {
    const pct = goal ? Math.min(100, (done / goal) * 100) : 0;
    return `<div class="panel goal"><div class="panel-head" style="margin-bottom:4px"><h2>${title}</h2><span class="muted">${esc(fmt(done))} of ${esc(fmt(goal))}</span></div>
      <div class="bar"><div class="${pct >= 100 ? 'done' : ''}" style="width:${pct}%"></div></div>
      <div class="faint" style="font-size:12.5px;margin-top:6px">${pct >= 100 ? 'Goal reached 🎉' : `${esc(fmt(goal - done))} to go`}</div></div>`;
  };
  box.innerHTML =
    (g.daily_minutes ? card('Today', byDay.get(today) || 0, g.daily_minutes * 60) : '') +
    (g.weekly_hours ? card('This week', week, g.weekly_hours * 3600) : '');
  box.classList.remove('hidden');
}

// ---------- projects ----------
let projects = [];
async function renderProjects() {
  projects = (await api('/users/current/projects')).data;
  const labels = [...new Set(Object.values(settings.project_labels || {}))].sort();
  $('#label-options').innerHTML = labels.map((l) => `<option value="${esc(l)}">`).join('');
  drawProjects();
}
function drawProjects() {
  const f = $('#proj-filter').value.trim().toLowerCase();
  const aliases = settings.project_aliases || {};
  const labels = settings.project_labels || {};
  const hidden = new Set((settings.hidden_projects || []).map((p) => p.toLowerCase()));
  const rows = projects.filter((p) => !f || p.name.toLowerCase().includes(f) || (aliases[p.name] || '').toLowerCase().includes(f));
  $('#proj-count').textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  $('#proj-table tbody').innerHTML = rows.length
    ? rows
        .map((p) => {
          const shown = aliases[p.name] || p.name;
          return `<tr data-name="${esc(p.name)}">
            <td><button type="button" class="linkish p-open" data-shown="${esc(shown)}">${p.name ? esc(p.name) : '<span class="faint">Unknown Project</span>'}</button>${shown !== p.name && p.name ? ` <span class="faint">→ ${esc(shown)}</span>` : ''}</td>
            <td class="num">${esc(p.text)}</td>
            <td><input type="text" class="p-alias" value="${esc(aliases[p.name] || '')}" placeholder="${esc(p.name)}" ${p.name ? '' : 'disabled'}></td>
            <td><input type="text" class="p-label" list="label-options" value="${esc(labels[shown] || '')}" placeholder="e.g. Client A" ${p.name ? '' : 'disabled'}></td>
            <td style="text-align:center"><input type="checkbox" class="p-hide" ${hidden.has(p.name.toLowerCase()) || hidden.has(shown.toLowerCase()) ? 'checked' : ''} ${p.name ? '' : 'disabled'}></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">No projects yet</td></tr>';
  document.querySelectorAll('.p-open').forEach((b) => (b.onclick = () => openProject(b.dataset.shown)));
}
$('#proj-filter').addEventListener('input', drawProjects);

// ---------- friends ----------
let friends = null; // list being edited
async function renderFriends() {
  if (!friends) friends = (settings.friends || []).map((f) => ({ ...f }));
  $('#fr-you').textContent = location.origin;
  drawFriendList();
  $('#fr-board').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { data } = await api(`/users/current/friends?range=${$('#fr-range').value}`);
    const max = Math.max(1, ...data.rows.map((r) => r.total_seconds));
    let rank = 0;
    $('#fr-board').innerHTML = `<table class="table board"><tbody>${data.rows
      .map((r) => {
        if (r.ok) rank++;
        const name = r.source === 'you' ? `${esc(r.name)} <span class="faint">(you)</span>` : `<a href="${esc(r.profile)}" target="_blank" rel="noopener">${esc(r.name)}</a>`;
        return `<tr class="${r.source === 'you' ? 'you' : ''}">
          <td class="rank">${r.ok ? rank : '–'}</td>
          <td>${name}${r.source === 'wakatime' ? ' <span class="faint">WakaTime</span>' : ''}</td>
          <td class="meter-cell">${r.ok ? `<div style="width:${Math.max(1, (r.total_seconds / max) * 100)}%"></div>` : `<span class="faint">${esc(r.error || '')}</span>`}</td>
          <td class="num">${r.ok ? esc(fmt(r.total_seconds)) : ''}</td>
          <td class="num muted">${r.ok && r.daily_average ? esc(fmt(r.daily_average)) + '/day' : ''}</td>
          <td class="muted">${esc(r.languages.join(', '))}</td>
        </tr>`;
      })
      .join('')}</tbody></table>${data.rows.length === 1 ? '<div class="empty">Add friends below to compare.</div>' : ''}`;
  } catch (e) {
    $('#fr-board').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
function drawFriendList() {
  $('#fr-count').textContent = `${friends.length} of 25`;
  $('#fr-list').innerHTML = friends.length
    ? friends
        .map(
          (f, i) => `<div class="fr-row" data-i="${i}">
            <input type="text" class="fr-name" maxlength="40" placeholder="Name" value="${esc(f.name)}">
            <input type="text" inputmode="url" class="fr-url" placeholder="https://waqt.example.com or https://wakatime.com/@name" value="${esc(f.url)}">
            <button class="btn small fr-del" type="button" title="Remove">✕</button>
          </div>`,
        )
        .join('')
    : '<div class="empty">No friends added yet.</div>';
  document.querySelectorAll('.fr-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.fr-name').oninput = (e) => (friends[i].name = e.target.value);
    row.querySelector('.fr-url').oninput = (e) => (friends[i].url = e.target.value);
    row.querySelector('.fr-del').onclick = () => {
      friends.splice(i, 1);
      drawFriendList();
    };
  });
}
$('#fr-add').onclick = () => {
  if (friends.length >= 25) return;
  friends.push({ name: '', url: '' });
  drawFriendList();
  document.querySelector('.fr-row:last-child .fr-name').focus();
};
$('#fr-save').onclick = async () => {
  $('#fr-err').textContent = '';
  try {
    const list = friends.filter((f) => f.url.trim());
    const { data } = await api('/users/current/settings', { method: 'PUT', body: JSON.stringify({ friends: list }) });
    settings = { ...settings, ...data };
    friends = null;
    toast('Friends saved');
    renderFriends();
  } catch (e) {
    $('#fr-err').textContent = e.message;
  }
};
$('#fr-range').onchange = renderFriends;

// ---------- one project in detail ----------
let openedProject = null;
async function openProject(name) {
  openedProject = name;
  $('#proj-detail').classList.remove('hidden');
  $('#proj-list').classList.add('hidden');
  $('#pd-name').textContent = name || 'Unknown Project';
  $('#pd-label').textContent = '';
  $('#pd-tiles').innerHTML = '';
  ['#pd-daily', '#pd-branches', '#pd-languages', '#pd-editors', '#pd-files'].forEach((id) => ($(id).innerHTML = '<div class="empty">Loading…</div>'));
  window.scrollTo({ top: 0 });
  try {
    const { data: p } = await api(`/users/current/project?name=${encodeURIComponent(name)}&days=${$('#pd-days').value}`);
    if (openedProject !== name) return;
    const others = p.names.filter((n) => n !== p.name);
    $('#pd-label').textContent = [p.label, others.length ? `includes ${others.join(', ')}` : ''].filter(Boolean).join(' · ');
    const top = (list) => (list[0] ? list[0].name : '—');
    $('#pd-tiles').innerHTML =
      tile('Time', p.text, p.active_days ? `${p.active_days} active day${p.active_days === 1 ? '' : 's'}` : 'no activity') +
      tile('Daily average', p.active_days ? fmt(p.total_seconds / p.active_days) : '—', 'on active days') +
      tile('Top branch', top(p.branches), p.branches[0] ? p.branches[0].text : '') +
      tile('Top language', top(p.languages), p.languages[0] ? p.languages[0].text : '') +
      tile('Last active', p.last_day ? prettyDate(p.last_day, { month: 'short', day: 'numeric', year: 'numeric' }) : '—', p.first_day ? `since ${prettyDate(p.first_day, { month: 'short', day: 'numeric', year: 'numeric' })}` : '');
    $('#pd-range').textContent = `${prettyDate(p.start)} – ${prettyDate(p.end)}`;
    dailyBars($('#pd-daily'), p.days, p.start, p.end);
    barList($('#pd-branches'), p.branches, 'branches');
    barList($('#pd-languages'), p.languages, 'languages');
    barList($('#pd-editors'), p.editors, 'editors');
    $('#pd-files').classList.add('file-list');
    barList($('#pd-files'), p.files, 'files', { limit: 15 });
    if (!p.branches.length && p.total_seconds) {
      $('#pd-branches').innerHTML = '<div class="empty">No file details for this range yet. They are rebuilt from raw heartbeats in the background, and imported history gets them when you import again.</div>';
    }
  } catch (e) {
    $('#pd-files').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
function closeProject() {
  openedProject = null;
  $('#proj-detail').classList.add('hidden');
  $('#proj-list').classList.remove('hidden');
}
$('#pd-close').onclick = closeProject;
$('#pd-days').onchange = () => openedProject !== null && openProject(openedProject);
$('#proj-save').onclick = async () => {
  $('#proj-err').textContent = '';
  const aliases = { ...(settings.project_aliases || {}) };
  const labels = { ...(settings.project_labels || {}) };
  const hidden = new Set(settings.hidden_projects || []);
  document.querySelectorAll('#proj-table tbody tr[data-name]').forEach((tr) => {
    const name = tr.dataset.name;
    if (!name) return;
    const alias = tr.querySelector('.p-alias').value.trim();
    const label = tr.querySelector('.p-label').value.trim();
    const hide = tr.querySelector('.p-hide').checked;
    if (alias && alias !== name) aliases[name] = alias;
    else delete aliases[name];
    const shown = alias || name;
    // Labels belong to the name you see, so merged projects share one label.
    if (label) labels[shown] = label;
    else delete labels[shown];
    if (hide) hidden.add(name);
    else {
      hidden.delete(name);
      if (shown !== name) hidden.delete(shown);
    }
  });
  try {
    const { data } = await api('/users/current/settings', {
      method: 'PUT',
      body: JSON.stringify({ project_aliases: aliases, project_labels: labels, hidden_projects: [...hidden] }),
    });
    settings = { ...settings, ...data };
    toast('Projects saved');
    renderProjects();
  } catch (e) {
    $('#proj-err').textContent = e.message;
  }
};

// ---------- timesheets ----------
let ts = null; // last loaded timesheet data
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function presetRange(p) {
  const today = localToday();
  const wd = new Date(today + 'T00:00:00Z').getUTCDay();
  const monday = addDays(today, -((wd + 6) % 7));
  const first = today.slice(0, 8) + '01';
  if (p === 'this_week') return [monday, today];
  if (p === 'last_week') return [addDays(monday, -7), addDays(monday, -1)];
  if (p === 'last_month') {
    const lastOfPrev = addDays(first, -1);
    return [lastOfPrev.slice(0, 8) + '01', lastOfPrev];
  }
  if (p === 'custom') return [$('#ts-start').value || first, $('#ts-end').value || today];
  return [first, today];
}
const money = (n) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: $('#ts-currency').value }).format(n);
  } catch {
    return n.toFixed(2);
  }
};
function roundedHours(seconds) {
  const step = Number($('#ts-round').value) * 60;
  const s = step ? Math.ceil(seconds / step) * step : seconds;
  return s / 3600;
}
function groups() {
  // Rounding is applied per day and project, like most timesheet tools.
  const byGroup = new Map();
  for (const r of ts.rows) {
    const label = r.label || 'No label';
    const g = $('#ts-group').value === 'label' ? label : r.project;
    if (!byGroup.has(g)) byGroup.set(g, { name: g, label, projects: new Map(), hours: 0 });
    const grp = byGroup.get(g);
    const h = roundedHours(r.seconds);
    grp.hours += h;
    grp.projects.set(r.project, (grp.projects.get(r.project) || 0) + h);
  }
  return [...byGroup.values()].sort((a, b) => b.hours - a.hours);
}
function rateFor(label) {
  const input = document.querySelector(`#ts-table input[data-label="${CSS.escape(label)}"]`);
  if (input && input.value !== '') return Number(input.value) || 0;
  return (ts.rates || {})[label] || 0;
}
async function loadTimesheet() {
  $('#ts-currency').value = settings.currency || 'USD';
  const [start, end] = presetRange($('#ts-preset').value);
  $('#ts-start').value = start;
  $('#ts-end').value = end;
  $('#ts-range-text').textContent = `${prettyDate(start, { month: 'short', day: 'numeric', year: 'numeric' })} – ${prettyDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  try {
    ts = (await api(`/users/current/timesheet?start=${start}&end=${end}`)).data;
  } catch (e) {
    $('#ts-table tbody').innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`;
    return;
  }
  drawTimesheet();
}
function drawTimesheet() {
  const byLabel = $('#ts-group').value === 'label';
  const gs = groups();
  let total = 0;
  let totalHours = 0;
  const body = gs
    .map((g) => {
      const rate = rateFor(g.label);
      const amount = g.hours * rate;
      total += amount;
      totalHours += g.hours;
      const head = `<tr><td><b>${esc(g.name)}</b></td><td class="num"><b>${g.hours.toFixed(2)}</b></td>
        <td class="num">${byLabel && g.label !== 'No label' ? `<input type="number" min="0" step="0.01" data-label="${esc(g.label)}" value="${(ts.rates || {})[g.label] ?? ''}" placeholder="0" style="width:110px;text-align:right">` : rate ? money(rate) : '—'}</td>
        <td class="num"><b>${amount ? money(amount) : '—'}</b></td></tr>`;
      const sub = byLabel
        ? [...g.projects.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([p, h]) => `<tr><td style="padding-left:26px" class="muted">${esc(p)}</td><td class="num">${h.toFixed(2)}</td><td></td><td class="num">${rate ? money(h * rate) : ''}</td></tr>`)
            .join('')
        : '';
      return head + sub;
    })
    .join('');
  $('#ts-table tbody').innerHTML = body || '<tr><td colspan="4" class="empty">No time tracked in this period</td></tr>';
  $('#ts-table tfoot').innerHTML = gs.length ? `<tr><td>Total</td><td class="num">${totalHours.toFixed(2)}</td><td></td><td class="num">${total ? money(total) : '—'}</td></tr>` : '';
  document.querySelectorAll('#ts-table input[data-label]').forEach((i) => i.addEventListener('input', () => {
    ts.rates = { ...(ts.rates || {}), [i.dataset.label]: Number(i.value) || 0 };
    clearTimeout(drawTimesheet.t);
    drawTimesheet.t = setTimeout(drawTimesheet, 500);
  }));
  const labels = [...new Set(ts.rows.map((r) => r.label || 'No label'))];
  $('#ts-bill').innerHTML = ['All clients', ...labels].map((l) => `<option>${esc(l)}</option>`).join('');
}
$('#ts-preset').addEventListener('change', () => {
  document.querySelectorAll('.ts-custom').forEach((el) => el.classList.toggle('hidden', $('#ts-preset').value !== 'custom'));
  loadTimesheet();
});
['#ts-start', '#ts-end'].forEach((sel) => $(sel).addEventListener('change', () => $('#ts-preset').value === 'custom' && loadTimesheet()));
['#ts-group', '#ts-round', '#ts-currency'].forEach((sel) => $(sel).addEventListener('change', () => ts && drawTimesheet()));
$('#ts-save-rates').onclick = async () => {
  try {
    const { data } = await api('/users/current/settings', {
      method: 'PUT',
      body: JSON.stringify({ label_rates: ts.rates || {}, currency: $('#ts-currency').value }),
    });
    settings = { ...settings, ...data };
    toast('Rates saved');
  } catch (e) {
    toast(e.message);
  }
};
$('#ts-csv').onclick = () => {
  if (!ts) return;
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['Date', 'Label', 'Project', 'Hours', 'Rate', 'Amount', 'Currency'].join(',')];
  for (const r of ts.rows) {
    const label = r.label || 'No label';
    const h = roundedHours(r.seconds);
    const rate = rateFor(label);
    lines.push([r.day, q(label), q(r.project), h.toFixed(2), rate.toFixed(2), (h * rate).toFixed(2), $('#ts-currency').value].join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timesheet-${ts.start}-to-${ts.end}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#ts-invoice').onclick = () => {
  if (!ts) return;
  const bill = $('#ts-bill').value;
  const rows = new Map();
  for (const r of ts.rows) {
    const label = r.label || 'No label';
    if (bill !== 'All clients' && label !== bill) continue;
    const cur = rows.get(r.project) || { label, hours: 0 };
    cur.hours += roundedHours(r.seconds);
    rows.set(r.project, cur);
  }
  let total = 0;
  const lines = [...rows.entries()]
    .sort((a, b) => b[1].hours - a[1].hours)
    .map(([project, v]) => {
      const rate = rateFor(v.label);
      total += v.hours * rate;
      return `<tr><td>${esc(project)}</td><td class="r">${v.hours.toFixed(2)}</td><td class="r">${money(rate)}</td><td class="r">${money(v.hours * rate)}</td></tr>`;
    })
    .join('');
  const no = `INV-${ts.end.replace(/-/g, '').slice(0, 6)}-${String(Math.floor(Math.random() * 900) + 100)}`;
  $('#invoice').innerHTML = `
    <h1>Invoice</h1><div class="label">${esc(no)} · ${esc(prettyDate(localToday(), { year: 'numeric', month: 'long', day: 'numeric' }))}</div>
    <div class="meta">
      <div><div class="label">From</div><b>${esc(ts.display_name)}</b></div>
      <div><div class="label">Bill to</div><b>${esc(bill)}</b></div>
      <div><div class="label">Period</div>${esc(prettyDate(ts.start, { month: 'short', day: 'numeric', year: 'numeric' }))} – ${esc(prettyDate(ts.end, { month: 'short', day: 'numeric', year: 'numeric' }))}</div>
    </div>
    <table><thead><tr><th>Project</th><th class="r">Hours</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody>${lines || '<tr><td colspan="4">No time in this period</td></tr>'}</tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td class="r">${money(total)}</td></tr></tfoot></table>
    <div class="foot">Hours tracked automatically with Waqt.</div>`;
  document.body.classList.add('printing');
  window.print();
  setTimeout(() => document.body.classList.remove('printing'), 500);
};

// ---------- share ----------
function cardUrl() {
  const kind = $('#c-kind').value;
  const range = $('#c-range').value;
  const theme = $('#c-theme').value;
  if (kind === 'badge') return `${origin}/badge/${range}.svg`;
  const p = new URLSearchParams();
  if (kind === 'wrapped') p.set('year', localToday().slice(0, 4));
  else if (kind !== 'heatmap') p.set('range', range);
  if (theme !== 'auto') p.set('theme', theme);
  if (!['stats', 'heatmap', 'hours', 'ai', 'wrapped'].includes(kind)) {
    if ($('#c-layout').value === 'compact') p.set('layout', 'compact');
    if ($('#c-count').value !== '6') p.set('count', $('#c-count').value);
  }
  const qs = p.toString();
  return `${origin}/card/${kind}.svg${qs ? '?' + qs : ''}`;
}

function codeBlock(el, text) {
  el.innerHTML = `${esc(text)}<button class="btn small copy" type="button">Copy</button>`;
  el.querySelector('.copy').onclick = () => copy(text);
}

function renderShare() {
  const url = cardUrl();
  const alt = 'Coding time tracked with Waqt';
  $('#c-preview').innerHTML = `<img src="${esc(url)}&_=${Date.now()}" alt="${esc(alt)}">`.replace('.svg&', '.svg?');
  const clean = url;
  codeBlock($('#c-md'), `[![${alt}](${clean})](${origin}/profile/)`);
  codeBlock($('#c-html'), `<a href="${origin}/profile/"><img src="${clean}" alt="${alt}"></a>`);
  codeBlock($('#p-link'), `${origin}/profile/`);
  codeBlock(
    $('#p-iframe'),
    `<iframe src="${origin}/profile/?embed=1&range=last_30_days&sections=stats,heatmap,languages" width="100%" height="560" style="border:0" loading="lazy" title="My coding activity"></iframe>`,
  );
  codeBlock(
    $('#t-grs'),
    `![WakaTime stats](https://github-readme-stats.vercel.app/api/wakatime?username=${settings.username}&api_domain=${host}&layout=compact)`,
  );
  codeBlock(
    $('#t-waka'),
    `- uses: athul/waka-readme@master\n  with:\n    WAKATIME_API_KEY: \${{ secrets.WAQT_API_KEY }}\n    API_BASE_URL: ${origin}/api`,
  );
  codeBlock($('#r-markers'), '<!--START_SECTION:waqt-->\n<!--END_SECTION:waqt-->');
  codeBlock(
    $('#r-workflow'),
    `name: Waqt stats
on:
  schedule:
    - cron: '17 */6 * * *'
  workflow_dispatch:
permissions:
  contents: write
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mohdrafey1/waqt/readme-action@main
        with:
          url: ${origin}
          api_key: \${{ secrets.WAQT_API_KEY }}
          range: last_7_days`,
  );
  if (!settings.public_enabled) {
    $('#c-preview').innerHTML = '<div class="muted">Your public profile is off. Turn it on in Settings to use cards and embeds.</div>';
  }
}
['#c-kind', '#c-range', '#c-theme', '#c-layout', '#c-count'].forEach((s) => $(s).addEventListener('change', renderShare));

// ---------- setup ----------
function renderSetup() {
  const cfg = (k) => `[settings]\napi_url = ${origin}/api/v1\napi_key = ${k}`;
  const shown = newKey || '<create a key below, or use your API_KEY>';
  $('#cfg').innerHTML = `${esc(cfg(shown))}${newKey ? '<button class="btn small copy" type="button">Copy</button>' : ''}`;
  if (newKey) $('#cfg .copy').onclick = () => copy(cfg(newKey));
  const s = settings.stats || {};
  const last = s.last_heartbeat ? new Date(s.last_heartbeat * 1000) : null;
  $('#status').innerHTML = `
    <dt>Last heartbeat</dt><dd>${last ? esc(last.toLocaleString()) : '<span class="faint">none yet</span>'}</dd>
    <dt>Raw heartbeats stored</dt><dd>${(s.heartbeats || 0).toLocaleString()}</dd>
    <dt>History since</dt><dd>${s.first_day ? esc(prettyDate(s.first_day, { year: 'numeric', month: 'short', day: 'numeric' })) : '—'}</dd>
    <dt>Days being recalculated</dt><dd>${s.pending_days || 0}</dd>
    <dt>Waqt version</dt><dd>${esc(settings.version || '')}${
      settings.update_available
        ? ` · <b style="color:var(--warn)">${esc(settings.latest_version)} is out</b> (<a href="${esc(settings.changelog)}" target="_blank" rel="noopener">what's new</a>). Update from your GitHub copy: Actions → Update Waqt → Run workflow.`
        : ' <span class="faint">(up to date)</span>'
    }</dd>
    <dt>Time zone</dt><dd>${esc(settings.effective_timezone)}</dd>
    <dt>Also sending to WakaTime</dt><dd>${
      !settings.forwarding
        ? '<span class="faint">Off (optional, see below)</span>'
        : settings.forwarding.error
          ? `<span style="color:var(--danger)">Failing: ${esc(settings.forwarding.error)}</span>`
          : `<span style="color:var(--ok)">On</span>, to ${esc(settings.forwarding.to)}`
    }</dd>`;
}
// ---------- free plan usage ----------
const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
async function renderUsage() {
  try {
    const { data: u } = await api('/users/current/usage');
    const meter = (label, used, max, pct, fmtv = (n) => n.toLocaleString()) => {
      const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
      return `<div class="meter"><div class="top"><span>${label}</span><span class="muted">${esc(fmtv(used))} of ${esc(fmtv(max))} · ${pct}%</span></div>
        <div class="track"><div class="${cls}" style="width:${Math.min(100, Math.max(pct, 0.5))}%"></div></div></div>`;
    };
    $('#usage-day').textContent = `Today (UTC) · ${u.raw_heartbeats.toLocaleString()} raw heartbeats stored`;
    $('#usage-meters').innerHTML =
      meter('Worker requests', u.today.requests, u.limits.requests, u.percent.requests) +
      meter('Database rows written', u.today.rows_written, u.limits.rows_written, u.percent.rows_written) +
      meter('Database rows read', u.today.rows_read, u.limits.rows_read, u.percent.rows_read) +
      meter('Database size', u.db_size, u.limits.db_bytes, u.percent.db_size, mb);
    return u;
  } catch (e) {
    $('#usage-meters').innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    return null;
  }
}
async function usageWarning() {
  try {
    const { data: u } = await api('/users/current/usage');
    const high = Object.entries(u.percent).filter(([, p]) => p >= 70);
    if (!high.length) return '';
    const names = { requests: 'Worker requests', rows_read: 'database reads', rows_written: 'database writes', db_size: 'database size' };
    return `<div class="banner"><b>Close to a free-plan limit:</b> ${high.map(([k, p]) => `${names[k]} at ${p}%`).join(', ')}. See <a href="#setup" class="go-setup">Setup</a> for details.</div>`;
  } catch {
    return '';
  }
}

// ---------- heartbeat inspector ----------
const MODEL_WORDS = /^(opus|sonnet|haiku|fable|mythos|gpt|gemini|gemma|qwen|deepseek|llama|mistral|grok|kimi|glm|o)\b/i;
function cell(value, { odd = false, title = '' } = {}) {
  if (!value) return `<td class="faint"${title ? ` title="${esc(title)}"` : ''}>—</td>`;
  return `<td${odd ? ' class="odd"' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(value)}</td>`;
}
async function renderInspector() {
  const project = $('#hb-project').value;
  try {
    const { data } = await api(`/users/current/heartbeats/recent?limit=100&project=${encodeURIComponent(project)}`);
    const sel = $('#hb-project');
    if (sel.options.length <= 1) sel.innerHTML += data.projects.map((p) => `<option value="${esc(p)}">${esc(p || 'Unknown Project')}</option>`).join('');
    $('#hb-table').classList.add('compact');
    $('#hb-table tbody').innerHTML = data.heartbeats.length
      ? data.heartbeats
          .map((h) => {
            const t = new Date(h.time * 1000);
            const file = (h.entity || '').split(/[\\/]/).pop();
            const tip = `${h.entity}\n${h.user_agent || '(user agent not stored for older heartbeats)'}${h.branch ? `\nbranch: ${h.branch}` : ''}`;
            return `<tr title="${esc(tip)}">
              <td class="num" style="text-align:left">${esc(t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} ${esc(t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</td>
              ${cell(h.project)}
              ${cell(h.language, { odd: /^<<.*>>$/.test(h.language || '') })}
              ${cell(h.editor, { odd: MODEL_WORDS.test(h.editor || '') })}
              ${cell(h.category)}
              ${cell(h.ai_model)}
              ${cell(file + (h.is_write ? ' ✎' : ''))}
              ${cell([h.os, h.machine].filter(Boolean).join(' · '))}
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="8" class="empty">No heartbeats yet</td></tr>';
    $('#hb-status').textContent = `${data.heartbeats.length} shown. ✎ = file was saved.`;
  } catch (e) {
    $('#hb-status').textContent = e.message;
  }
}
$('#hb-project').addEventListener('change', renderInspector);
$('#hb-refresh').onclick = renderInspector;
$('#hb-reparse').onclick = async () => {
  $('#hb-status').textContent = 'Re-reading user agents…';
  try {
    const { data } = await api('/users/current/maintenance/reparse', { method: 'POST' });
    toast(data.changed ? `Fixed ${data.changed} heartbeats; totals are being rebuilt` : 'Everything was already read correctly');
    renderInspector();
  } catch (e) {
    $('#hb-status').textContent = e.message;
  }
};

// ---------- import ----------
async function renderImport() {
  try {
    const st = (await api('/users/current/import/status')).data;
    $('#import-cutoff').textContent = st.own_since_day ? prettyDate(st.own_since_day, { year: 'numeric', month: 'short', day: 'numeric' }) : 'your first heartbeat';
    $('#import-nokey').classList.toggle('hidden', st.wakatime_key);
    $('#import-start').disabled = !st.wakatime_key;
    $('#import-remove').classList.toggle('hidden', !st.imported.days);
    $('#import-summary').textContent = st.imported.days
      ? `${st.imported.days} days imported · ${fmt(st.imported.seconds)}`
      : '';
  } catch (e) {
    $('#import-summary').textContent = e.message;
  }
}

async function startImport(file) {
  $('#import-progress').classList.remove('hidden');
  $('#import-start').disabled = true;
  const set = (msg, pct) => {
    $('#import-status').textContent = msg;
    if (pct != null) $('#import-bar').style.width = Math.min(100, pct) + '%';
  };
  try {
    const r = await runImport({ api, headers: AUTH_HEADERS, file, onStatus: set });
    const long = { year: 'numeric', month: 'short', day: 'numeric' };
    let msg = `Done: imported ${r.days} days (${fmt(r.seconds)}), ${prettyDate(r.first, long)} to ${prettyDate(r.last, long)}.`;
    if (r.filled_days) msg += ` WakaTime's export ended ${prettyDate(r.export_end, long)}, so the days after it were fetched one by one.`;
    if (r.missing_days.length) msg += ` Couldn't fetch ${r.missing_days.join(', ')} from WakaTime; import again later to fill them in.`;
    if (r.truncated) msg += ' Only the first 62 days after the export could be fetched.';
    set(msg, 100);
    toast('Import finished');
  } catch (e) {
    set('Import stopped: ' + e.message);
  }
  $('#import-file').value = '';
  renderImport();
}

$('#waka-check').onclick = async () => {
  const box = $('#waka-check-result');
  box.classList.remove('hidden');
  box.innerHTML = '<span class="muted">Asking WakaTime…</span>';
  try {
    const { data: r } = await api('/users/current/import/wakatime/check', { method: 'POST' });
    const mark = (ok) => (ok ? '<span style="color:var(--ok)">✓</span>' : '<span style="color:var(--danger)">✕</span>');
    const why = (x) => (x && !x.ok ? ` <span class="muted">(WakaTime answered ${x.status || 'nothing'}${x.reason ? `: ${esc(x.reason)}` : ''})</span>` : '');
    let html = '';
    // Forwarding: the API key
    if (r.api_key.set) html += `<div>${mark(r.api_key.send.ok)} <b>Sending activity to WakaTime</b> with <code>WAKATIME_API_KEY</code> (<code>${esc(r.api_key.hint)}</code>)${why(r.api_key.send)}</div>`;
    else html += '<div class="muted">Sending activity to WakaTime: off (no <code>WAKATIME_API_KEY</code> secret).</div>';
    // Import: the OAuth token
    if (r.read_with) {
      const who = r.user ? ` as <b>${esc(r.user.username || 'you')}</b>${r.user.plan ? ` (${esc(r.user.plan)} plan)` : ''}` : '';
      html += `<div>${mark(r.account.ok && r.import.ok)} <b>Importing history</b> with <code>${r.read_with}</code>${r.read_with === 'WAKATIME_OAUTH_TOKEN' ? ` (<code>${esc(r.oauth_token.hint)}</code>)` : ''}${who}${why(!r.account.ok ? r.account : r.import)}</div>`;
    } else {
      html += '<div class="muted">Importing history: no credential set.</div>';
    }
    const needToken = r.read_with !== 'WAKATIME_OAUTH_TOKEN' && !(r.account?.ok && r.import?.ok);
    if (needToken) {
      html += '<div style="margin-top:6px">For importing, copy your personal token from <a href="https://wakatime.com/oauth" target="_blank" rel="noopener">wakatime.com/oauth</a> and add it in Cloudflare as a second Secret named <code>WAKATIME_OAUTH_TOKEN</code>. Keep <code>WAKATIME_API_KEY</code> (from <a href="https://wakatime.com/api-key" target="_blank" rel="noopener">wakatime.com/api-key</a>) for sending activity.</div>';
    } else if (r.api_key.set && !r.api_key.send.ok) {
      html += '<div style="margin-top:6px">For sending activity, <code>WAKATIME_API_KEY</code> must be the Secret API Key from <a href="https://wakatime.com/api-key" target="_blank" rel="noopener">wakatime.com/api-key</a> (it starts with <code>waka_</code>).</div>';
    }
    box.innerHTML = html;
  } catch (e) {
    box.textContent = e.message;
  }
};
$('#import-start').onclick = () => startImport();
$('#import-file').onchange = (e) => e.target.files[0] && startImport(e.target.files[0]);
$('#import-remove').onclick = async () => {
  if (!window.confirm('Remove all imported WakaTime history from Waqt? Your own Waqt data is not affected.')) return;
  await api('/users/current/import', { method: 'DELETE' });
  toast('Imported history removed');
  renderImport();
};

// ---------- backups ----------
function backupProgress(msg, pct) {
  $('#backup-progress').classList.remove('hidden');
  $('#backup-status').textContent = msg;
  if (pct != null) $('#backup-bar').style.width = Math.min(100, pct) + '%';
}
async function renderBackup() {
  $('#backup-url').innerHTML = `<code>${esc(location.origin)}</code>`;
  try {
    const { data: m } = await api('/users/current/backup');
    $('#backup-summary').textContent = m.first_day ? `History from ${prettyDate(m.first_day, { year: 'numeric', month: 'short', day: 'numeric' })}` : 'Nothing to back up yet';
  } catch (e) {
    $('#backup-summary').textContent = e.message;
  }
}
async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return { blob: new Blob([text], { type: 'application/json' }), ext: 'json' };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { blob: await new Response(stream).blob(), ext: 'json.gz' };
}
async function readBackupFile(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(await file.text());
}
$('#backup-download').onclick = async () => {
  $('#backup-download').disabled = true;
  try {
    const b = await createBackup(api, backupProgress);
    const { blob, ext } = await gzip(JSON.stringify(b));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `waqt-backup-${localToday()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const rows = Object.values(b.tables).reduce((n, t) => n + t.rows.length, 0);
    backupProgress(`Saved ${a.download} (${rows.toLocaleString()} rows, ${(blob.size / 1024).toFixed(0)} KB).`, 100);
  } catch (e) {
    backupProgress('Backup failed: ' + e.message);
  }
  $('#backup-download').disabled = false;
};
$('#backup-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let b;
  try {
    b = await readBackupFile(file);
  } catch {
    backupProgress('That file is not a Waqt backup.');
    return;
  }
  const range = b.first_day ? `${b.first_day} to ${b.last_day}` : 'no days';
  if (!window.confirm(`Restore ${file.name} (${range})?\n\nDays in the backup replace the same days here, and its settings replace yours. Days not in the backup are kept.`)) return;
  try {
    const r = await restoreBackup(api, b, backupProgress);
    backupProgress(`Restored ${r.days} days (${r.rows.toLocaleString()} rows). Reloading…`, 100);
    toast('Backup restored');
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    backupProgress('Restore stopped: ' + err.message);
  }
};

$('#newkey').onclick = async () => {
  try {
    const { data } = await api('/users/current/keys', { method: 'POST', body: JSON.stringify({ name: $('#newkey-name').value.trim() || guessDevice() }) });
    newKey = data.key;
    $('#newkey-name').value = '';
    $('#newkey-hint').innerHTML = `<b>Copy it now:</b> Waqt only keeps a fingerprint of “${esc(data.name)}”, so this key can't be shown again. You can revoke it any time in Settings.`;
    renderSetup();
  } catch (e) {
    toast(e.message);
  }
};
function guessDevice() {
  const ua = navigator.userAgent;
  return /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux machine' : 'Device';
}

// ---------- sign-in and device keys ----------
const when = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
async function renderSecurity() {
  $('#pw-state').textContent = settings.password_set
    ? 'A password is set. You can sign in with it or with your main key. Changing it signs out every other browser.'
    : 'No password yet: you sign in with your main key. Set one so you never need to paste the key into a browser.';
  $('#pw-save').textContent = settings.password_set ? 'Change password' : 'Set password';
  $('#pw-remove').classList.toggle('hidden', !settings.password_set);
  try {
    const [{ data: keys }, { data: sessions }] = await Promise.all([api('/users/current/keys'), api('/users/current/sessions')]);
    $('#keys-table tbody').innerHTML = keys.length
      ? keys
          .map(
            (k) => `<tr class="${k.revoked_at ? 'faint' : ''}"><td>${esc(k.name)}</td><td><code>••••${esc(k.hint)}</code></td><td>${when(k.created_at)}</td><td>${k.revoked_at ? 'revoked ' + when(k.revoked_at) : when(k.last_used)}</td>
              <td style="text-align:right">${k.revoked_at ? '' : `<button class="btn small key-revoke" data-id="${k.id}" data-name="${esc(k.name)}" type="button">Revoke</button>`}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No device keys yet. Create one in Setup.</td></tr>';
    document.querySelectorAll('.key-revoke').forEach(
      (b) =>
        (b.onclick = async () => {
          if (!window.confirm(`Revoke “${b.dataset.name}”? Editors using it stop sending activity.`)) return;
          await api('/users/current/keys/' + b.dataset.id, { method: 'DELETE' });
          toast('Key revoked');
          renderSecurity();
        }),
    );
    $('#sessions').innerHTML = sessions.length
      ? `<table class="table"><tbody>${sessions
          .map((x) => `<tr><td>${esc(browserName(x.user_agent))}${x.current ? ' <span class="faint">(this browser)</span>' : ''}</td><td>signed in ${when(x.created_at)}</td><td>last seen ${when(x.last_seen)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="empty">Only API keys are in use.</div>';
    $('#sessions-end').classList.toggle('hidden', sessions.filter((x) => !x.current).length === 0);
  } catch (e) {
    $('#pw-err').textContent = e.message;
  }
}
function browserName(ua) {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}
$('#pw-save').onclick = async () => {
  $('#pw-err').textContent = '';
  const pw = $('#pw-new').value;
  if (pw.length < 10) return ($('#pw-err').textContent = 'Use at least 10 characters.');
  if (pw !== $('#pw-again').value) return ($('#pw-err').textContent = "The two passwords don't match.");
  try {
    await api('/users/current/password', { method: 'PUT', body: JSON.stringify({ password: pw }) });
    $('#pw-new').value = $('#pw-again').value = '';
    settings.password_set = true;
    toast('Password saved');
    renderSecurity();
  } catch (e) {
    $('#pw-err').textContent = e.message;
  }
};
$('#pw-remove').onclick = async () => {
  if (!window.confirm('Remove the dashboard password? You will sign in with your main key instead.')) return;
  await api('/users/current/password', { method: 'DELETE' });
  settings.password_set = false;
  toast('Password removed');
  renderSecurity();
};
$('#sessions-end').onclick = async () => {
  const { data } = await api('/users/current/sessions', { method: 'DELETE' });
  toast(`Signed out ${data.signed_out} other browser${data.signed_out === 1 ? '' : 's'}`);
  renderSecurity();
};

// ---------- settings ----------
function renderSettings() {
  const tzSel = $('#s-tz');
  if (!tzSel.options.length) {
    let zones = [];
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = [settings.effective_timezone];
    }
    if (!zones.includes(settings.effective_timezone)) zones.unshift(settings.effective_timezone);
    tzSel.innerHTML = zones.map((z) => `<option>${esc(z)}</option>`).join('');
  }
  tzSel.value = settings.effective_timezone;
  $('#s-display').value = settings.display_name || '';
  $('#s-username').value = settings.username;
  $('#s-public').checked = settings.public_enabled;
  $('#s-public-projects').checked = settings.public_projects;
  $('#s-hidden').value = (settings.hidden_projects || []).join('\n');
  $('#s-timeout').value = settings.timeout_minutes;
  $('#s-retention').value = settings.raw_retention_days;
  $('#s-goal-day').value = String(settings.goal_daily_minutes || 0);
  if (!$('#s-goal-day').value) $('#s-goal-day').value = '0';
  $('#s-goal-week').value = settings.goal_weekly_hours || '';
  $('#s-report').checked = settings.report_enabled;
  $('#s-statusbar-goal').checked = !!settings.statusbar_goal;
  $('#s-nudge-goal').checked = !!settings.nudge_goal;
  $('#s-nudge-streak').checked = !!settings.nudge_streak;
  if (!$('#s-nudge-hour').options.length) {
    $('#s-nudge-hour').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
  }
  $('#s-nudge-hour').value = String(settings.nudge_streak_hour ?? 21);
  $('#s-discord').value = '';
  $('#s-discord').placeholder = settings.report_discord_set ? 'Saved (type a new URL to replace, or clear below)' : 'https://discord.com/api/webhooks/…';
  $('#s-tg-token').value = '';
  $('#s-tg-token').placeholder = settings.report_telegram_bot
    ? `Saved for bot ${settings.report_telegram_bot}… (paste a new token to replace)`
    : '123456789:ABC…';
  $('#s-tg-chat').value = settings.report_telegram_chat || '';
  $('#s-report-result').textContent = '';
  $('#s-err').textContent = '';
  renderSecurity();
}

async function saveSettingsForm() {
  $('#s-err').textContent = '';
  try {
    const body = {
      display_name: $('#s-display').value,
      username: $('#s-username').value,
      timezone: $('#s-tz').value,
      public_enabled: $('#s-public').checked,
      public_projects: $('#s-public-projects').checked,
      hidden_projects: $('#s-hidden').value.split('\n').map((x) => x.trim()).filter(Boolean),
      timeout_minutes: Number($('#s-timeout').value),
      raw_retention_days: Number($('#s-retention').value),
      goal_daily_minutes: Number($('#s-goal-day').value),
      goal_weekly_hours: Number($('#s-goal-week').value || 0),
      report_enabled: $('#s-report').checked,
      statusbar_goal: $('#s-statusbar-goal').checked,
      nudge_goal: $('#s-nudge-goal').checked,
      nudge_streak: $('#s-nudge-streak').checked,
      nudge_streak_hour: Number($('#s-nudge-hour').value),
      report_telegram_chat: $('#s-tg-chat').value.trim(),
    };
    // Only send secrets when typed, so saved ones aren't wiped.
    if ($('#s-discord').value.trim()) body.report_discord = $('#s-discord').value.trim();
    if ($('#s-tg-token').value.trim()) body.report_telegram_token = $('#s-tg-token').value.trim();
    const { data } = await api('/users/current/settings', { method: 'PUT', body: JSON.stringify(body) });
    settings = { ...settings, ...data };
    toast(data.rebuilding_days ? `Saved. Rebuilding ${data.rebuilding_days} days in the background.` : 'Saved');
    renderSettings();
    return true;
  } catch (err) {
    $('#s-err').textContent = err.message;
    return false;
  }
}
$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveSettingsForm();
});

$('#s-report-test').onclick = async () => {
  $('#s-report-result').textContent = 'Sending…';
  // Save first so a freshly typed webhook is used.
  if (!(await saveSettingsForm())) {
    $('#s-report-result').textContent = '';
    return;
  }
  try {
    const { data } = await api('/users/current/report/test', { method: 'POST' });
    const t = data.telegram;
    const bot = !t
      ? ''
      : t.ok
        ? ` The saved token is for ${t.bot}.`
        : ` The saved token starts with ${t.saved_bot_id}: and is ${t.saved_length} characters long; Telegram says "${t.error}" for it.`;
    $('#s-report-result').textContent = (data.sent.length ? `Sent to ${data.sent.join(' and ')}. ` : '') + data.errors.join(' ') + bot;
  } catch (e) {
    $('#s-report-result').textContent = e.message;
  }
};

// ---------- boot ----------
function start() {
  if (settings.site_url !== location.origin) {
    api('/users/current/settings', { method: 'PUT', body: JSON.stringify({ site_url: location.origin }) }).catch(() => {});
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const r = store('waqt_range');
  if (r && [...$('#range').options].some((o) => o.value === r)) $('#range').value = r;
  const tab = location.hash.slice(1);
  showTab(['ai', 'projects', 'timesheets', 'friends', 'share', 'setup', 'settings'].includes(tab) ? tab : 'overview');
  loadOverview().catch((e) => {
    $('#notice').innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  });
}

(async () => {
  try {
    if (await loadSettings()) return start();
    // Older versions kept the key in this browser; trade it for a session once.
    const saved = store('waqt_key');
    if (saved) {
      store('waqt_key', null);
      if (await signIn(saved).catch(() => false)) return start();
    }
    const { data } = await api('/auth/status');
    if (data.password_set) {
      $('#login-hint').innerHTML = 'Use your dashboard password, or the API key you set as the <code>API_KEY</code> secret.';
      $('#login-key').placeholder = 'Password or API key';
    }
  } catch (e) {
    $('#login-err').textContent = e.message;
  }
  $('#login').classList.remove('hidden');
})();
