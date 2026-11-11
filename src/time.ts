// Time zone and duration helpers. Days are "YYYY-MM-DD" strings in the user's time zone.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(ms: number, tz: string) {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Day string for a unix timestamp (seconds) in the given zone. */
export function dayOf(epochSeconds: number, tz: string): string {
  const p = zonedParts(epochSeconds * 1000, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Unix timestamp (seconds) of local midnight at the start of `day`. */
export function dayStart(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = offsetMs(guess, tz);
  let start = guess - first;
  const second = offsetMs(start, tz);
  if (second !== first) start = guess - second;
  return start / 1000;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const a = Date.parse(start + 'T00:00:00Z');
  const b = Date.parse(end + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

export function weekday(day: string): number {
  return new Date(day + 'T00:00:00Z').getUTCDay();
}

export function todayIn(tz: string): string {
  return dayOf(Date.now() / 1000, tz);
}

export function isDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export const RANGES: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 Days',
  last_14_days: 'Last 14 Days',
  last_30_days: 'Last 30 Days',
  last_6_months: 'Last 6 Months',
  last_year: 'Last Year',
  all_time: 'All Time',
};

const RANGE_DAYS: Record<string, number> = {
  last_7_days: 7,
  last_14_days: 14,
  last_30_days: 30,
  last_6_months: 183,
  last_year: 365,
};

export interface Range {
  name: string;
  label: string;
  start: string;
  end: string;
}

/** Resolve a named range (or explicit start/end) into inclusive day bounds. */
export function resolveRange(
  name: string | undefined,
  tz: string,
  firstDay: string | null,
  start?: string,
  end?: string,
): Range | null {
  const today = todayIn(tz);
  if (isDay(start) && isDay(end) && start <= end) {
    return { name: 'custom', label: `${start} – ${end}`, start, end };
  }
  const n = name || 'last_7_days';
  if (n === 'today') return { name: n, label: RANGES[n], start: today, end: today };
  if (n === 'yesterday') {
    const y = addDays(today, -1);
    return { name: n, label: RANGES[n], start: y, end: y };
  }
  if (n === 'all_time') {
    const s = firstDay && firstDay < today ? firstDay : today;
    return { name: n, label: RANGES[n], start: s, end: today };
  }
  const days = RANGE_DAYS[n];
  if (!days) return null;
  return { name: n, label: RANGES[n], start: addDays(today, -(days - 1)), end: today };
}

// ---- duration formatting (matches WakaTime's style) ----

export function durationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} hr${h === 1 ? '' : 's'}` + (m > 0 ? ` ${m} min${m === 1 ? '' : 's'}` : '');
  if (m > 0) return `${m} min${m === 1 ? '' : 's'}`;
  const s = total % 60;
  return `${s} sec${s === 1 ? '' : 's'}`;
}

/** Short form for tight spaces: "12h 5m", "45m", "0m". */
export function durationShort(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function durationItem(name: string, seconds: number, total: number) {
  const t = Math.max(0, Math.round(seconds));
  const hours = Math.floor(t / 3600);
  const minutes = Math.floor((t % 3600) / 60);
  return {
    name,
    total_seconds: Math.round(seconds * 1000) / 1000,
    percent: total > 0 ? Math.round((seconds / total) * 10000) / 100 : 0,
    digital: `${hours}:${pad(minutes)}`,
    decimal: (seconds / 3600).toFixed(2),
    text: durationText(seconds),
    hours,
    minutes,
    seconds: t % 60,
  };
}
