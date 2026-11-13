// Weekly coding report, sent every Monday morning (your time zone) to Discord
// and/or Telegram. No email service needed.

import { usd } from './readme';
import { Env, Settings, saveSettings, tzOf } from './settings';
import { buildStats, streaks } from './stats';
import { addDays, dayStart, durationShort, durationText, todayIn, weekday } from './time';

const SEND_HOUR = 9; // local time, Mondays

export interface Report {
  title: string;
  lines: string[]; // each already formatted with **bold** markers
}

function pctChange(now: number, before: number): string {
  if (!before) return now ? 'first tracked week' : '';
  const p = Math.round(((now - before) / before) * 100);
  return `${p >= 0 ? '+' : ''}${p}% vs the week before`;
}

const shortDate = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekdayName = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

/** Report for the 7 days ending on `end` (inclusive). */
export async function buildReport(env: Env, s: Settings, end: string, siteUrl = ''): Promise<Report> {
  const start = addDays(end, -6);
  const [st, prev, year] = await Promise.all([
    buildStats(env, s, { name: 'custom', label: '', start, end }, 'private'),
    buildStats(env, s, { name: 'custom', label: '', start: addDays(start, -7), end: addDays(start, -1) }, 'private'),
    buildStats(env, s, { name: 'custom', label: '', start: addDays(end, -364), end }, 'private'),
  ]);
  const lines: string[] = [];
  const change = pctChange(st.total_seconds, prev.total_seconds);
  lines.push(
    `⏱ **${durationText(st.total_seconds)}**${change ? ` (${change})` : ''} · ${st.days_minus_holidays} active day${st.days_minus_holidays === 1 ? '' : 's'} · avg ${durationText(st.daily_average)}`,
  );
  if (s.goal_daily_minutes || s.goal_weekly_hours) {
    const parts: string[] = [];
    if (s.goal_daily_minutes) {
      const hit = st.days.filter((d) => d.total_seconds >= s.goal_daily_minutes * 60).length;
      parts.push(`daily goal (${durationText(s.goal_daily_minutes * 60)}) hit on **${hit} of 7** days`);
    }
    if (s.goal_weekly_hours) {
      const pct = Math.round((st.total_seconds / (s.goal_weekly_hours * 3600)) * 100);
      parts.push(`weekly goal (${s.goal_weekly_hours} hrs) **${pct}%** ${pct >= 100 ? '✅' : ''}`.trim());
    }
    lines.push(`🎯 ${parts.join(' · ')}`);
  }
  if (st.best_day) lines.push(`🏆 Best day: **${weekdayName(st.best_day.date)}**, ${durationText(st.best_day.total_seconds)}`);
  const top = (items: { name: string; total_seconds: number }[] | undefined, n = 3) =>
    (items || []).slice(0, n).map((i) => `${i.name} ${durationShort(i.total_seconds)}`).join(' · ');
  if (st.languages.length) lines.push(`💬 Languages: ${top(st.languages)}`);
  if (st.projects?.length) lines.push(`📁 Projects: ${top(st.projects)}`);
  if (st.labels && st.labels.some((l) => l.name !== 'No label')) lines.push(`🏷 Labels: ${top(st.labels.filter((l) => l.name !== 'No label'))}`);
  if (st.ai.seconds || st.ai.ai_lines) {
    const bits = [];
    if (st.ai.seconds) bits.push(`${durationText(st.ai.seconds)} with AI agents`);
    if (st.ai.ai_lines + st.ai.human_lines) bits.push(`${Math.round(st.ai.ai_percent_of_lines)}% of changed lines by AI`);
    if (st.ai.models[0]) bits.push(`mostly ${st.ai.models[0].name}`);
    if (st.ai.cost && st.ai.cost.total > 0) bits.push(`about ${usd(st.ai.cost.total)} in API tokens`);
    lines.push(`🤖 ${bits.join(' · ')}`);
  }
  if (st.dayparts.persona) lines.push(`🕑 You were a **${st.dayparts.persona}** this week`);
  const streak = streaks(year.days, end);
  if (streak.current) lines.push(`🔥 Streak: **${streak.current} day${streak.current === 1 ? '' : 's'}** (longest ${streak.longest} day${streak.longest === 1 ? '' : 's'})`);
  if (!st.total_seconds) lines.splice(0, lines.length, 'No coding activity this week. Fresh start on Monday! 🌱');
  if (siteUrl) lines.push(siteUrl);
  return { title: `📊 Your coding week · ${shortDate(start)} – ${shortDate(end)}`, lines };
}

function toDiscord(r: Report): string {
  return [`**${r.title}**`, ...r.lines].join('\n').slice(0, 1990);
}

function toTelegramHtml(r: Report): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bold = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  return [`<b>${esc(r.title)}</b>`, ...r.lines.map(bold)].join('\n').slice(0, 4000);
}

export async function sendReport(env: Env, s: Settings, r: Report): Promise<{ sent: string[]; errors: string[] }> {
  const sent: string[] = [];
  const errors: string[] = [];
  if (s.report_discord) {
    try {
      const res = await fetch(s.report_discord, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Waqt', content: toDiscord(r) }),
      });
      if (res.ok) sent.push('Discord');
      else errors.push(`Discord answered ${res.status}. Check the webhook URL.`);
    } catch (e) {
      errors.push(`Discord: ${String((e as Error).message || e)}`);
    }
  }
  if (s.report_telegram_token && s.report_telegram_chat) {
    const base = ((env as { TELEGRAM_API_URL?: string }).TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/bot${s.report_telegram_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: s.report_telegram_chat, text: toTelegramHtml(r), parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (res.ok) sent.push('Telegram');
      else {
        const body = (await res.json().catch(() => ({}))) as { description?: string };
        const d = body.description || `status ${res.status}`;
        const hint =
          res.status === 401 || res.status === 404
            ? "Telegram doesn't recognise the bot token. Copy it again from @BotFather: send /mybots, pick your bot, tap API Token."
            : /chat not found/i.test(d)
              ? "Telegram can't find that chat. Open your bot, tap Start, and check the Id from @userinfobot."
              : res.status === 403
                ? "Open your bot in Telegram and tap Start (and make sure it isn't blocked)."
                : 'Check the bot token and chat ID.';
        errors.push(`Telegram: ${d}. ${hint}`);
      }
    } catch (e) {
      errors.push(`Telegram: ${String((e as Error).message || e)}`);
    }
  }
  if (!s.report_discord && !(s.report_telegram_token && s.report_telegram_chat)) errors.push('Add a Discord webhook or a Telegram bot first.');
  return { sent, errors };
}

/** Cron: on Monday from 9:00 local time, send last week's report once. */
export async function maybeSendWeekly(env: Env, s: Settings): Promise<boolean> {
  if (!s.report_enabled) return false;
  const tz = tzOf(s);
  const today = todayIn(tz);
  if (weekday(today) !== 1) return false; // Monday
  const hour = Math.floor((Date.now() / 1000 - dayStart(today, tz)) / 3600);
  if (hour < SEND_HOUR) return false;
  const lastSunday = addDays(today, -1);
  if (s.last_report_week === lastSunday) return false;
  // Mark first, so a failing channel can't cause a report every 15 minutes.
  await saveSettings(env.DB, { last_report_week: lastSunday });
  s.last_report_week = lastSunday;
  const r = await buildReport(env, s, lastSunday, s.site_url);
  await sendReport(env, s, r);
  return true;
}

