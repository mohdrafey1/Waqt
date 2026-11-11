// Short messages to Discord/Telegram when you reach a goal, or when your streak
// is about to end. Checked by the cron every 15 minutes; each goes out at most once.

import { sendReport } from './report';
import { Env, Settings, saveSettings, tzOf } from './settings';
import { addDays, dayStart, durationText, todayIn, weekday } from './time';

const ACTIVE_DAY = 60; // seconds, same as streaks in stats.ts

const hasChannel = (s: Settings) => !!s.report_discord || !!(s.report_telegram_token && s.report_telegram_chat);
const mondayOf = (day: string) => addDays(day, -((weekday(day) + 6) % 7));

async function totalBetween(env: Env, from: string, to: string): Promise<number> {
  const r = await env.DB.prepare('SELECT SUM(seconds) AS s FROM daily_summaries WHERE day BETWEEN ?1 AND ?2').bind(from, to).first<{ s: number | null }>();
  return r?.s || 0;
}

/** Length of the run of active days ending on `day`. */
export async function streakEndingOn(env: Env, day: string): Promise<number> {
  const { results } = await env.DB.prepare(
    'SELECT day FROM daily_summaries WHERE day BETWEEN ?1 AND ?2 GROUP BY day HAVING SUM(seconds) >= ?3 ORDER BY day DESC',
  )
    .bind(addDays(day, -400), day, ACTIVE_DAY)
    .all<{ day: string }>();
  let n = 0;
  let cursor = day;
  for (const r of results) {
    if (r.day !== cursor) break;
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

export async function maybeNudge(env: Env, s: Settings): Promise<string[]> {
  if ((!s.nudge_goal && !s.nudge_streak) || !hasChannel(s)) return [];
  const tz = tzOf(s);
  const today = todayIn(tz);
  const sent: string[] = [];
  const send = async (title: string, lines: string[]) => {
    await sendReport(env, s, { title, lines: s.site_url ? [...lines, s.site_url] : lines });
    sent.push(title);
  };

  let todaySecs: number | null = null;
  const todayTotal = async () => (todaySecs ??= await totalBetween(env, today, today));

  if (s.nudge_goal && s.goal_daily_minutes && s.last_goal_nudge !== today) {
    const secs = await todayTotal();
    if (secs >= s.goal_daily_minutes * 60) {
      await saveSettings(env.DB, { last_goal_nudge: today }); // mark first: never twice
      await send('🎯 Daily goal reached', [`**${durationText(secs)}** today, your goal is ${durationText(s.goal_daily_minutes * 60)}. Nice work!`]);
    }
  }

  const monday = mondayOf(today);
  if (s.nudge_goal && s.goal_weekly_hours && s.last_week_goal_nudge !== monday) {
    const secs = await totalBetween(env, monday, today);
    if (secs >= s.goal_weekly_hours * 3600) {
      await saveSettings(env.DB, { last_week_goal_nudge: monday });
      await send('🏆 Weekly goal reached', [`**${durationText(secs)}** this week, your goal is ${s.goal_weekly_hours} hrs.`]);
    }
  }

  if (s.nudge_streak && s.last_streak_nudge !== today) {
    const hour = Math.floor((Date.now() / 1000 - dayStart(today, tz)) / 3600);
    if (hour >= s.nudge_streak_hour && (await todayTotal()) < ACTIVE_DAY) {
      await saveSettings(env.DB, { last_streak_nudge: today }); // once a day, sent or not
      const streak = await streakEndingOn(env, addDays(today, -1));
      if (streak >= 2) {
        await send('🔥 Keep your streak going', [`You've coded **${streak} days** in a row. A few minutes before midnight keeps it alive.`]);
      }
    }
  }
  return sent;
}
