import { LOGO, barList, copy, dailyBars, esc, fmt, heatmap, prettyDate, toast } from './shared.js';

const $ = (s) => document.querySelector(s);
const origin = location.origin;
const host = location.host;
let key = '';
let settings = null;

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
  return null;
}

async function api(path, opts = {}) {
  const res = await fetch('/api/v1' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
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

async function tryLogin(k) {
  key = k.trim().toLowerCase();
  try {
    settings = (await api('/users/current/settings')).data;
    return true;
  } catch (e) {
    $('#login-err').textContent = e.status === 401 ? 'That key does not match this Waqt instance.' : e.message;
    return false;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await tryLogin($('#login-key').value)) {
    store('waqt_key', key);
    start();
  }
});

$('#logout').onclick = () => {
  store('waqt_key', null);
  location.reload();
};

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab)),
);
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  $('#range').classList.toggle('hidden', name !== 'overview');
  history.replaceState(null, '', name === 'overview' ? '#' : '#' + name);
  if (name === 'share') renderShare();
  if (name === 'setup') renderSetup();
  if (name === 'settings') renderSettings();
}

// ---------- overview ----------
$('#range').addEventListener('change', () => {
  store('waqt_range', $('#range').value);
  loadOverview();
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
  if (st.total_seconds === 0 && year.total_seconds === 0) {
    $('#notice').innerHTML = `<div class="banner"><b>No activity yet.</b> Head to <a href="#setup" id="go-setup">Setup</a> to connect your editor. It takes about a minute.</div>`;
    $('#go-setup').onclick = (e) => {
      e.preventDefault();
      showTab('setup');
    };
  } else {
    $('#notice').innerHTML = '';
  }
}

// ---------- share ----------
function cardUrl() {
  const kind = $('#c-kind').value;
  const range = $('#c-range').value;
  const theme = $('#c-theme').value;
  if (kind === 'badge') return `${origin}/badge/${range}.svg`;
  const p = new URLSearchParams();
  if (kind !== 'heatmap') p.set('range', range);
  if (theme !== 'auto') p.set('theme', theme);
  if (!['stats', 'heatmap'].includes(kind)) {
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
  if (!settings.public_enabled) {
    $('#c-preview').innerHTML = '<div class="muted">Your public profile is off. Turn it on in Settings to use cards and embeds.</div>';
  }
}
['#c-kind', '#c-range', '#c-theme', '#c-layout', '#c-count'].forEach((s) => $(s).addEventListener('change', renderShare));

// ---------- setup ----------
let revealed = false;
function renderSetup() {
  const shown = revealed ? key : key.slice(0, 8) + '-••••-••••-••••-••••••••••••';
  const cfg = (k) => `[settings]\napi_url = ${origin}/api/v1\napi_key = ${k}`;
  $('#cfg').innerHTML = `${esc(cfg(shown))}<button class="btn small copy" type="button">Copy</button>`;
  $('#cfg .copy').onclick = () => copy(cfg(key));
  $('#reveal').textContent = revealed ? 'Hide key' : 'Show key';
  const s = settings.stats || {};
  const last = s.last_heartbeat ? new Date(s.last_heartbeat * 1000) : null;
  $('#status').innerHTML = `
    <dt>Last heartbeat</dt><dd>${last ? esc(last.toLocaleString()) : '<span class="faint">none yet</span>'}</dd>
    <dt>Raw heartbeats stored</dt><dd>${(s.heartbeats || 0).toLocaleString()}</dd>
    <dt>History since</dt><dd>${s.first_day ? esc(prettyDate(s.first_day, { year: 'numeric', month: 'short', day: 'numeric' })) : '—'}</dd>
    <dt>Days being recalculated</dt><dd>${s.pending_days || 0}</dd>
    <dt>Time zone</dt><dd>${esc(settings.effective_timezone)}</dd>`;
}
$('#reveal').onclick = () => {
  revealed = !revealed;
  renderSetup();
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
  $('#s-err').textContent = '';
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
    };
    const { data } = await api('/users/current/settings', { method: 'PUT', body: JSON.stringify(body) });
    settings = { ...settings, ...data };
    toast(data.rebuilding_days ? `Saved. Rebuilding ${data.rebuilding_days} days in the background.` : 'Saved');
  } catch (err) {
    $('#s-err').textContent = err.message;
  }
});

// ---------- boot ----------
function start() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const r = store('waqt_range');
  if (r && [...$('#range').options].some((o) => o.value === r)) $('#range').value = r;
  const tab = location.hash.slice(1);
  showTab(['share', 'setup', 'settings'].includes(tab) ? tab : 'overview');
  loadOverview().catch((e) => {
    $('#notice').innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  });
}

(async () => {
  const saved = store('waqt_key');
  if (saved && (await tryLogin(saved))) return start();
  $('#login-err').textContent = '';
  $('#login').classList.remove('hidden');
})();
