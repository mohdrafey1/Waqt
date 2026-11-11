// Waqt Wrapped: a year of coding as a few full-screen slides, built from the
// public stats (so what you see is exactly what others see when you share it).

import { LOGO, colorFor, copy, esc, fmt, hourBars, prettyDate, toast } from '/shared.js';

document.documentElement.dataset.theme = 'dark';
const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const thisYear = new Date().getFullYear();
const year = Math.min(thisYear, Math.max(2000, Number(q.get('year')) || thisYear));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GLOWS = [
  ['rgba(139,92,246,.30)', 'rgba(6,182,212,.16)'],
  ['rgba(236,72,153,.24)', 'rgba(139,92,246,.20)'],
  ['rgba(16,185,129,.22)', 'rgba(59,130,246,.18)'],
  ['rgba(245,158,11,.22)', 'rgba(239,68,68,.16)'],
];

$('#brand').innerHTML = `${LOGO}<span>Waqt Wrapped · ${year}</span>`;
document.title = `Waqt Wrapped ${year}`;

const hrs = (s) => Math.round(s / 3600).toLocaleString();
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function longestStreak(days) {
  const active = days.filter((d) => d.total_seconds >= 60).map((d) => d.date).sort();
  let best = 0;
  let run = 0;
  let best_end = null;
  let prev = null;
  for (const d of active) {
    const next = prev && new Date(Date.parse(prev + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    run = next === d ? run + 1 : 1;
    if (run > best) {
      best = run;
      best_end = d;
    }
    prev = d;
  }
  return { days: best, end: best_end };
}

function ranks(items, dim, n = 5) {
  const top = items.slice(0, n);
  const max = Math.max(1, ...top.map((i) => i.total_seconds));
  return `<div class="rows">${top
    .map(
      (it, i) => `<div class="rank"><span class="n">${i + 1}</span><span>${esc(it.name)}</span><span class="v">${hrs(it.total_seconds)} hrs</span>
        <div class="bar"><div style="width:${(it.total_seconds / max) * 100}%;background:${colorFor(dim, it.name, i)}"></div></div></div>`,
    )
    .join('')}</div>`;
}

function buildSlides(st) {
  const name = st.display_name && st.display_name !== st.username ? st.display_name : '';
  const slides = [];
  const total = st.total_seconds;
  const active = st.days_minus_holidays;
  const streak = longestStreak(st.days);
  const months = new Array(12).fill(0);
  for (const d of st.days) months[Number(d.date.slice(5, 7)) - 1] += d.total_seconds;
  const bestMonth = months.indexOf(Math.max(...months));
  const isOver = year < thisYear;

  slides.push({
    html: `<div class="kicker">Waqt Wrapped ${year}</div>
      <div class="big">${name ? `${esc(name)}'s` : 'My'} year in code${isOver ? '' : ', so far'}.</div>
      <p class="lede">Every hour in the editor, every language and late night, wrapped up. Tap or press → to begin.</p>
      <div class="years">${[thisYear, thisYear - 1, thisYear - 2]
        .map((y) => `<a class="btn small${y === year ? ' primary' : ''}" href="?year=${y}">${y}</a>`)
        .join('')}</div>`,
  });

  if (!total) {
    slides.push({ html: `<div class="big">Nothing tracked in ${year}.</div><p class="lede">Try another year, or come back after some coding.</p>` });
    return slides;
  }

  slides.push({
    html: `<div class="kicker">Total time</div>
      <div class="huge">${hrs(total)}<small>hours</small></div>
      <p class="lede">spent coding in ${year}. That's <b>${(total / 86400).toFixed(1)} full days</b>, or about <b>${fmt(total / Math.max(1, active))}</b> on each day you coded.</p>`,
  });

  slides.push({
    html: `<div class="kicker">Showing up</div>
      <div class="huge">${active}<small>days</small></div>
      <p class="lede">You coded on ${plural(active, 'day')}${streak.days > 1 ? `, with a longest streak of <b>${plural(streak.days, 'day')}</b> in a row (ending ${esc(prettyDate(streak.end, { month: 'long', day: 'numeric' }))})` : ''}.</p>
      ${st.best_day ? `<div class="facts"><div><span>Biggest day</span><b>${esc(fmt(st.best_day.total_seconds))}</b>${esc(prettyDate(st.best_day.date, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
      <div><span>Busiest month</span><b>${MONTHS[bestMonth]}</b>${hrs(months[bestMonth])} hrs</div></div>` : ''}`,
  });

  if (st.languages?.length) {
    const l = st.languages;
    slides.push({
      html: `<div class="kicker">Languages</div>
        <div class="big">${esc(l[0].name)} was your #1.</div>
        <p class="lede">${l.length > 1 ? `You wrote in ${plural(l.length, 'language')} this year.` : ''}</p>${ranks(l, 'languages')}`,
    });
  }

  slides.push({
    html: `<div class="kicker">When you code</div>
      <div class="big">${esc(st.dayparts.persona || 'Around the clock')}</div>
      <p class="lede">${st.best_weekday ? `${esc(st.best_weekday)}s were your busiest days.` : ''} Here's your year by hour of day:</p>
      <div class="chart" id="hours-chart"></div>`,
    after: () => hourBars($('#hours-chart'), st.hours),
  });

  const tools = (st.editors || []).filter((e) => e.name && e.name !== 'Unknown');
  if (tools.length) {
    slides.push({
      html: `<div class="kicker">Your tools</div>
        <div class="big">Mostly in ${esc(tools[0].name)}.</div>${ranks(tools, 'editors', 4)}`,
    });
  }

  const a = st.ai;
  const lines = a.ai_lines + a.human_lines;
  if (a.seconds || lines) {
    slides.push({
      html: `<div class="kicker">AI pair programming</div>
        <div class="big">${lines ? `${Math.round(a.ai_percent_of_lines)}% of your changed lines came from AI.` : `${fmt(a.seconds)} with AI agents.`}</div>
        <div class="facts">
          ${a.seconds ? `<div><span>Agent time</span><b>${a.seconds >= 7200 ? `${hrs(a.seconds)} hrs` : esc(fmt(a.seconds))}</b></div>` : ''}
          ${a.models?.[0] ? `<div><span>Favourite model</span><b>${esc(a.models[0].name)}</b></div>` : ''}
          ${a.sessions ? `<div><span>Sessions</span><b>${a.sessions.toLocaleString()}</b></div>` : ''}
          ${lines ? `<div><span>Lines by you</span><b>${a.human_lines.toLocaleString()}</b></div>` : ''}
        </div>`,
    });
  }

  if (st.projects?.length) {
    slides.push({
      html: `<div class="kicker">Projects</div><div class="big">${esc(st.projects[0].name)} got the most love.</div>${ranks(st.projects, 'projects')}`,
    });
  }

  const card = `/card/wrapped.svg?year=${year}&theme=dark`;
  const pageUrl = `${location.origin}/wrapped/?year=${year}`;
  const text = `My ${year} in code: ${hrs(total)} hours over ${active} days${st.languages?.[0] ? `, mostly ${st.languages[0].name}` : ''}.`;
  slides.push({
    html: `<div class="kicker">That's a wrap</div>
      <img class="card-img" src="${card}" alt="${esc(text)}" width="600" height="278">
      <div class="actions">
        <button class="btn primary" id="dl" type="button">Download image</button>
        <button class="btn" id="cp" type="button">Copy link</button>
        <a class="btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}">Share on X</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}">LinkedIn</a>
        <button class="btn" id="md" type="button">Copy for README</button>
      </div>`,
    after: () => {
      $('#dl').onclick = () => downloadPng(card, `waqt-wrapped-${year}.png`);
      $('#cp').onclick = () => copy(pageUrl);
      $('#md').onclick = () => copy(`[![My ${year} in code](${location.origin}${card.replace('&theme=dark', '')})](${pageUrl})`);
    },
  });
  return slides;
}

async function downloadPng(src, filename) {
  try {
    const svg = await (await fetch(src)).text();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    await new Promise((ok, bad) => {
      img.onload = ok;
      img.onerror = bad;
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    toast("Couldn't make the image. Right-click the card to save it instead.");
  }
}

let slides = [];
let at = 0;
function show(i) {
  at = Math.max(0, Math.min(slides.length - 1, i));
  const s = slides[at];
  const el = $('#slide');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  el.innerHTML = s.html;
  if (s.after) s.after();
  $('#progress').innerHTML = slides.map((_, k) => `<i class="${k <= at ? 'done' : ''}"></i>`).join('');
  $('#prev').disabled = at === 0;
  $('#next').disabled = at === slides.length - 1;
  $('#next').textContent = at === 0 ? 'Start →' : 'Next →';
  const [g1, g2] = GLOWS[at % GLOWS.length];
  $('#glow').style.background = `radial-gradient(circle at 20% 15%, ${g1}, transparent 45%), radial-gradient(circle at 85% 80%, ${g2}, transparent 45%)`;
  history.replaceState(null, '', `?year=${year}${at ? `#${at + 1}` : ''}`);
}

$('#prev').onclick = () => show(at - 1);
$('#next').onclick = () => show(at + 1);
// Tap the left third to go back, anywhere else to go on (links and buttons work as usual).
$('.stage').addEventListener('click', (e) => {
  if (e.target.closest('a, button, input, select, .chart')) return;
  show(e.clientX < window.innerWidth / 3 ? at - 1 : at + 1);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') show(at + 1);
  if (e.key === 'ArrowLeft') show(at - 1);
});

(async () => {
  try {
    const res = await fetch(`/api/v1/users/public/stats?start=${year}-01-01&end=${year}-12-31`);
    if (res.status === 403) {
      slides = [{ html: '<div class="big">This profile is private.</div><p class="lede">Its owner can turn on <b>Public profile and cards</b> in Settings to share their Wrapped.</p>' }];
    } else {
      if (!res.ok) throw new Error();
      slides = buildSlides((await res.json()).data);
    }
  } catch {
    slides = [{ html: '<div class="big">Something went wrong.</div><p class="lede">Couldn\'t load the stats. Try again in a moment.</p>' }];
  }
  const hash = Number(location.hash.slice(1));
  show(hash ? hash - 1 : 0);
})();
