// Shared formatting and chart helpers for the dashboard and the public profile.

export const LANGUAGE_COLORS = {
  javascript: '#f1e05a', jsx: '#e7c547', typescript: '#3178c6', tsx: '#7aa2f7', python: '#3572A5',
  java: '#b07219', kotlin: '#A97BFF', go: '#00ADD8', rust: '#dea584', c: '#555555', 'c++': '#f34b7d',
  'c#': '#178600', swift: '#F05138', dart: '#00B4AB', php: '#4F5D95', ruby: '#701516', html: '#e34c26',
  css: '#663399', scss: '#c6538c', vue: '#41b883', svelte: '#ff3e00', astro: '#ff5a03', json: '#cbcb41',
  yaml: '#cb171e', toml: '#9c4221', xml: '#0060ac', markdown: '#083fa1', sql: '#e38c00', shell: '#89e051',
  bash: '#89e051', powershell: '#012456', dockerfile: '#384d54', lua: '#000080', r: '#198CE7',
  scala: '#c22d40', haskell: '#5e5086', elixir: '#6e4a7e', zig: '#ec915c', graphql: '#e10098',
  prisma: '#0c344b', solidity: '#AA6746', 'jupyter notebook': '#DA5B0B', text: '#9198a1', other: '#8b949e',
};
export const PALETTE = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#3b82f6', '#84cc16', '#f97316', '#14b8a6', '#a855f7', '#eab308'];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function colorFor(dim, name, i) {
  if (dim === 'languages') return LANGUAGE_COLORS[name.toLowerCase()] || PALETTE[hash(name) % PALETTE.length];
  if (dim === 'files') return PALETTE[0];
  return PALETTE[i % PALETTE.length];
}

export function fmt(sec) {
  const t = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (h > 0) return `${h} hr${h === 1 ? '' : 's'}` + (m ? ` ${m} min${m === 1 ? '' : 's'}` : '');
  if (m > 0) return `${m} min${m === 1 ? '' : 's'}`;
  return `${t} sec${t === 1 ? '' : 's'}`;
}
export function fmtShort(sec) {
  const t = Math.max(0, Math.round((sec || 0) / 60));
  const h = Math.floor(t / 60);
  const m = t % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function prettyDate(day, opts = { month: 'short', day: 'numeric' }) {
  return new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

// ---------- tooltip ----------
let tip;
function showTip(e, text) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.style.display = 'block';
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + 'px';
  tip.style.top = e.clientY - 34 + 'px';
}
function hideTip() {
  if (tip) tip.style.display = 'none';
}
function attachTips(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip));
    el.addEventListener('mouseleave', hideTip);
  });
}

// ---------- ranked list with bars ----------
export function barList(el, items, dim, { limit = 8 } = {}) {
  if (!items || !items.length) {
    el.innerHTML = '<div class="empty">No activity in this range</div>';
    return;
  }
  const total = items.reduce((a, i) => a + i.total_seconds, 0);
  const render = (n) => {
    el.innerHTML =
      '<div class="bars">' +
      items
        .slice(0, n)
        .map((it, i) => {
          const pct = total ? (it.total_seconds / total) * 100 : 0;
          const c = colorFor(dim, it.name, i);
          return `<div class="bar-row"><div class="top"><div class="name"><i class="dot" style="background:${c}"></i><span title="${esc(it.name)}">${esc(it.name)}</span></div><div class="val">${fmtShort(it.total_seconds)} · ${pct.toFixed(pct < 1 ? 1 : 0)}%</div></div><div class="track"><div class="fill" style="width:${Math.max(pct, 1)}%;background:${c}"></div></div></div>`;
        })
        .join('') +
      '</div>' +
      (items.length > n ? `<button class="btn small more">Show all ${items.length}</button>` : '');
    const more = el.querySelector('.more');
    if (more) more.onclick = () => render(items.length);
  };
  render(limit);
}

// ---------- daily bars (groups by week / month for long ranges) ----------
export function dailyBars(el, days, start, end) {
  const map = new Map(days.map((d) => [d.date, d.total_seconds]));
  const all = [];
  for (let d = start; d <= end; d = addDays(d, 1)) all.push({ date: d, total_seconds: map.get(d) || 0 });
  let buckets = all;
  let unit = 'day';
  if (all.length > 730) unit = 'month';
  else if (all.length > 120) unit = 'week';
  if (unit !== 'day') {
    const m = new Map();
    for (const d of all) {
      const key = unit === 'month' ? d.date.slice(0, 7) : weekStart(d.date);
      m.set(key, (m.get(key) || 0) + d.total_seconds);
    }
    buckets = [...m.entries()].map(([date, total_seconds]) => ({ date, total_seconds }));
  }
  const max = Math.max(1, ...buckets.map((b) => b.total_seconds));
  const label = (b) =>
    unit === 'month'
      ? new Date(b.date + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
      : unit === 'week'
        ? 'Week of ' + prettyDate(b.date)
        : prettyDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' });
  el.innerHTML =
    `<div class="daily">` +
    buckets
      .map(
        (b) =>
          `<div class="col" data-tip="${esc(label(b))} · ${esc(fmt(b.total_seconds))}"><div class="b" style="height:${((b.total_seconds / max) * 100).toFixed(2)}%"></div></div>`,
      )
      .join('') +
    `</div><div class="daily-axis"><span>${esc(label(buckets[0]))}</span><span>${unit === 'day' ? 'per day' : 'per ' + unit}</span><span>${esc(label(buckets[buckets.length - 1]))}</span></div>`;
  attachTips(el);
}
function weekStart(day) {
  const wd = new Date(day + 'T00:00:00Z').getUTCDay();
  return addDays(day, -((wd + 6) % 7));
}

// ---------- GitHub-style heatmap of the last year ----------
export function heatmap(el, days, today) {
  const map = new Map(days.map((d) => [d.date, d.total_seconds]));
  const max = Math.max(1, ...days.map((d) => d.total_seconds));
  const wd = new Date(today + 'T00:00:00Z').getUTCDay();
  const start = addDays(today, -(52 * 7 + wd));
  let cells = '';
  let months = '';
  let lastMonth = '';
  for (let w = 0; w < 53; w++) {
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, w * 7 + d);
      if (day > today) {
        cells += '<i class="out"></i>';
        continue;
      }
      const s = map.get(day) || 0;
      const f = s / max;
      const lvl = s <= 0 ? 0 : f < 0.25 ? 1 : f < 0.5 ? 2 : f < 0.75 ? 3 : 4;
      cells += `<i class="l${lvl}" data-tip="${esc(prettyDate(day, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))} · ${esc(fmt(s))}"></i>`;
      if (d === 0 && day.slice(5, 7) !== lastMonth && w < 52) {
        if (lastMonth || Number(day.slice(8)) <= 7) {
          months += `<span style="left:${w * 15}px">${new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}</span>`;
        }
        lastMonth = day.slice(5, 7);
      }
    }
  }
  el.innerHTML =
    `<div class="heat-wrap"><div class="heat-inner"><div class="heat-months" style="width:${53 * 15}px">${months}</div><div class="heat">${cells}</div></div></div>` +
    `<div class="legend">Less <i class="l0" style="background:var(--panel-2)"></i>` +
    [1, 2, 3, 4].map((l) => `<i class="l${l}" style="background:${['', 'color-mix(in srgb,var(--accent) 32%,var(--panel-2))', 'color-mix(in srgb,var(--accent) 56%,var(--panel-2))', 'color-mix(in srgb,var(--accent) 80%,var(--panel-2))', 'var(--accent)'][l]}"></i>`).join('') +
    ` More</div>`;
  attachTips(el);
  const wrap = el.querySelector('.heat-wrap');
  wrap.scrollLeft = wrap.scrollWidth;
}

// ---------- hour of day / weekday bars ----------
export function hourBars(el, hours) {
  const max = Math.max(1, ...hours);
  const label = (h) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);
  el.innerHTML =
    `<div class="daily" style="height:130px">` +
    hours
      .map((s, h) => `<div class="col" data-tip="${label(h)}–${label((h + 1) % 24)} · ${esc(fmt(s))}"><div class="b" style="height:${((s / max) * 100).toFixed(2)}%;${h < 6 || h >= 18 ? 'opacity:.75' : ''}"></div></div>`)
      .join('') +
    `</div><div class="daily-axis"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>11 pm</span></div>`;
  attachTips(el);
}

export function weekdayBars(el, weekdays) {
  // Monday first
  const order = [1, 2, 3, 4, 5, 6, 0].map((i) => weekdays[i]);
  const max = Math.max(1, ...order.map((d) => d.total_seconds));
  el.innerHTML =
    '<div class="bars">' +
    order
      .map(
        (d) => `<div class="bar-row"><div class="top"><div class="name"><span>${esc(d.name)}</span></div><div class="val">${fmtShort(d.total_seconds)}</div></div>
        <div class="track"><div class="fill" style="width:${Math.max((d.total_seconds / max) * 100, d.total_seconds ? 1 : 0)}%;background:var(--accent)"></div></div></div>`,
      )
      .join('') +
    '</div>';
}

export function compact(n) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed: select the text and copy it manually');
  }
}

export const LOGO = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#8b5cf6"/><circle cx="16" cy="16" r="9" stroke="#fff" stroke-width="2.4"/><path d="M16 10.5V16l3.8 2.6" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
