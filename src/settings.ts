import { isValidTimeZone } from './time';
import { type Price, parsePrices } from './pricing';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  API_KEY?: string;
  /** Optional: also send every heartbeat to WakaTime with this key. */
  WAKATIME_API_KEY?: string;
  /** Optional: forward somewhere other than WakaTime (any WakaTime-compatible API). */
  WAKATIME_API_URL?: string;
}

export interface Settings {
  timezone: string; // empty until the first heartbeat tells us
  username: string;
  display_name: string;
  public_enabled: boolean;
  public_projects: boolean;
  hidden_projects: string[];
  timeout_minutes: number;
  raw_retention_days: number;
  raw_since: number; // heartbeats before this unix time may have been pruned
  last_prune_day: string;
  forward_error: string; // last forwarding error, empty when it's working
  forward_enabled: boolean; // forwarding also needs the WAKATIME_API_KEY secret
  project_aliases: Record<string, string>; // "old name" -> "shown as"
  project_labels: Record<string, string>; // project (after aliasing) -> label, e.g. a client
  label_rates: Record<string, number>; // label -> hourly rate for timesheets
  currency: string;
  goal_daily_minutes: number;
  goal_weekly_hours: number;
  report_enabled: boolean;
  report_discord: string;
  report_telegram_token: string;
  report_telegram_chat: string;
  last_report_week: string;
  needs_rebuild: boolean;
  first_heartbeat: number; // unix time of the first heartbeat Waqt ever received (0 = none yet)
  site_url: string; // where the dashboard lives, for links in reports
  parser_version: number; // user-agent parser version the stored heartbeats were read with
  ai_prices: Price[]; // USD per million tokens, see pricing.ts
  ai_prices_custom: boolean;
  ai_cost_public: boolean; // show the AI cost estimate on the public profile and README
  nudge_goal: boolean; // message when a daily/weekly goal is reached
  nudge_streak: boolean; // message when the streak is about to end
  nudge_streak_hour: number; // local hour for the streak reminder
  last_goal_nudge: string;
  last_week_goal_nudge: string;
  last_streak_nudge: string;
  statusbar_goal: boolean; // show daily goal progress in the editor status bar
}

export const DEFAULTS: Record<string, string> = {
  timezone: '',
  username: 'me',
  display_name: '',
  public_enabled: '1',
  public_projects: '0',
  hidden_projects: '[]',
  timeout_minutes: '15',
  raw_retention_days: '365',
  raw_since: '0',
  last_prune_day: '',
  forward_error: '',
  forward_enabled: '1',
  project_aliases: '{}',
  project_labels: '{}',
  label_rates: '{}',
  currency: 'USD',
  goal_daily_minutes: '0',
  goal_weekly_hours: '0',
  report_enabled: '0',
  report_discord: '',
  report_telegram_token: '',
  report_telegram_chat: '',
  last_report_week: '',
  needs_rebuild: '0',
  first_heartbeat: '0',
  site_url: '',
  parser_version: '0',
  ai_prices: '',
  ai_cost_public: '0',
  nudge_goal: '0',
  nudge_streak: '0',
  nudge_streak_hour: '21',
  last_goal_nudge: '',
  last_week_goal_nudge: '',
  last_streak_nudge: '',
  statusbar_goal: '0',
};

function obj<T>(json: string, check: (v: unknown) => v is T): Record<string, T> {
  try {
    const o = JSON.parse(json);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(o)) if (check(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parse(raw: Record<string, string>): Settings {
  const v = { ...DEFAULTS, ...raw };
  let hidden: string[] = [];
  try {
    const h = JSON.parse(v.hidden_projects);
    if (Array.isArray(h)) hidden = h.filter((x) => typeof x === 'string');
  } catch {}
  return {
    timezone: v.timezone,
    username: v.username || 'me',
    display_name: v.display_name,
    public_enabled: v.public_enabled === '1',
    public_projects: v.public_projects === '1',
    hidden_projects: hidden,
    timeout_minutes: clampInt(v.timeout_minutes, 1, 120, 15),
    raw_retention_days: clampInt(v.raw_retention_days, 0, 36500, 365),
    raw_since: Number(v.raw_since) || 0,
    last_prune_day: v.last_prune_day,
    forward_error: v.forward_error,
    forward_enabled: v.forward_enabled !== '0',
    project_aliases: obj(v.project_aliases, isStr),
    project_labels: obj(v.project_labels, isStr),
    label_rates: obj(v.label_rates, isNum),
    currency: /^[A-Z]{3}$/.test(v.currency) ? v.currency : 'USD',
    goal_daily_minutes: clampInt(v.goal_daily_minutes, 0, 1440, 0),
    goal_weekly_hours: clampInt(v.goal_weekly_hours, 0, 168, 0),
    report_enabled: v.report_enabled === '1',
    report_discord: v.report_discord,
    report_telegram_token: v.report_telegram_token,
    report_telegram_chat: v.report_telegram_chat,
    last_report_week: v.last_report_week,
    needs_rebuild: v.needs_rebuild === '1',
    first_heartbeat: Number(v.first_heartbeat) || 0,
    site_url: v.site_url,
    parser_version: Number(v.parser_version) || 0,
    ai_prices: parsePrices(v.ai_prices),
    ai_prices_custom: !!v.ai_prices,
    ai_cost_public: v.ai_cost_public === '1',
    nudge_goal: v.nudge_goal === '1',
    nudge_streak: v.nudge_streak === '1',
    nudge_streak_hour: clampInt(v.nudge_streak_hour, 0, 23, 21),
    last_goal_nudge: v.last_goal_nudge,
    last_week_goal_nudge: v.last_week_goal_nudge,
    last_streak_nudge: v.last_streak_nudge,
    statusbar_goal: v.statusbar_goal === '1',
  };
}

function clampInt(s: string, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(s));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const raw: Record<string, string> = {};
  for (const r of results) raw[r.key] = r.value;
  return parse(raw);
}

/** Effective zone used for day boundaries. */
export function tzOf(s: Settings): string {
  return s.timezone && isValidTimeZone(s.timezone) ? s.timezone : 'UTC';
}

export function upsertStatement(db: D1Database, values: Record<string, string>): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value) SELECT key, value FROM json_each(?1) WHERE true
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify(values));
}

export async function saveSettings(db: D1Database, values: Record<string, string>): Promise<void> {
  await upsertStatement(db, values).run();
}

/** The subset of settings safe to show in the dashboard. */
export function publicSettingsView(s: Settings) {
  return {
    timezone: s.timezone,
    username: s.username,
    display_name: s.display_name,
    public_enabled: s.public_enabled,
    public_projects: s.public_projects,
    hidden_projects: s.hidden_projects,
    timeout_minutes: s.timeout_minutes,
    raw_retention_days: s.raw_retention_days,
    forward_enabled: s.forward_enabled,
    project_aliases: s.project_aliases,
    project_labels: s.project_labels,
    label_rates: s.label_rates,
    currency: s.currency,
    goal_daily_minutes: s.goal_daily_minutes,
    goal_weekly_hours: s.goal_weekly_hours,
    report_enabled: s.report_enabled,
    // Secrets are never sent back in full, only whether they're set.
    report_discord_set: !!s.report_discord,
    report_telegram_set: !!(s.report_telegram_token && s.report_telegram_chat),
    report_telegram_chat: s.report_telegram_chat,
    site_url: s.site_url,
    ai_prices: s.ai_prices,
    ai_prices_custom: s.ai_prices_custom,
    ai_cost_public: s.ai_cost_public,
    nudge_goal: s.nudge_goal,
    nudge_streak: s.nudge_streak,
    nudge_streak_hour: s.nudge_streak_hour,
    statusbar_goal: s.statusbar_goal,
  };
}

/** Project name as shown, after any rename/merge the user set up. */
export function aliasOf(s: Settings, project: string): string {
  return s.project_aliases[project] || project;
}
