import { isValidTimeZone } from './time';

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
}

const DEFAULTS: Record<string, string> = {
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
};

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
  };
}
