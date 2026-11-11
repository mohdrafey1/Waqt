// A private leaderboard with friends: other Waqt instances (their public stats)
// or WakaTime users with public stats. Fetched by the Worker, so browsers don't
// run into cross-origin rules, and cached for 10 minutes.

export type Friend = { name: string; url: string };

export const MAX_FRIENDS = 25;
const TTL = 600;
export const FRIEND_RANGES = ['last_7_days', 'last_30_days'] as const;

export function cleanFriends(list: unknown): Friend[] | null {
  if (!Array.isArray(list) || list.length > MAX_FRIENDS) return null;
  const out: Friend[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') return null;
    const name = String((f as Friend).name || '').trim().slice(0, 40);
    let url = String((f as Friend).url || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    } catch {
      return null;
    }
    out.push({ name: name || new URL(url).hostname, url: url.replace(/\/+$/, '') });
  }
  return out;
}

/** Where to read a friend's stats, and the page to link to. */
export function friendEndpoints(url: string, range: string): { api: string; profile: string; source: 'waqt' | 'wakatime' } {
  const u = new URL(url);
  if (/(^|\.)wakatime\.com$/i.test(u.hostname)) {
    const user = (u.pathname.match(/^\/(@[^/]+)/) || u.pathname.match(/^\/users\/([^/]+)/) || [])[1] || '';
    return { api: `https://wakatime.com/api/v1/users/${user}/stats/${range}`, profile: `https://wakatime.com/${user}`, source: 'wakatime' };
  }
  const base = `${u.origin}${u.pathname.replace(/\/(profile|api)(\/.*)?$/, '').replace(/\/+$/, '')}`;
  return { api: `${base}/api/v1/users/public/stats/${range}`, profile: `${base}/profile/`, source: 'waqt' };
}

type Row = {
  name: string;
  url: string;
  profile: string;
  source: 'waqt' | 'wakatime' | 'you';
  ok: boolean;
  error?: string;
  total_seconds: number;
  daily_average: number;
  languages: string[];
};

type StatsLike = { total_seconds?: number; daily_average?: number; languages?: { name: string }[]; is_up_to_date?: boolean };

export async function friendRow(f: Friend, range: string): Promise<Row> {
  const ep = friendEndpoints(f.url, range);
  const base = { name: f.name, url: f.url, profile: ep.profile, source: ep.source, total_seconds: 0, daily_average: 0, languages: [] };
  try {
    const res = await fetch(ep.api, { headers: { Accept: 'application/json', 'User-Agent': 'Waqt friends leaderboard' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 403 || res.status === 404) return { ...base, ok: false, error: 'Their stats are private' };
    if (!res.ok) return { ...base, ok: false, error: `Answered ${res.status}` };
    const body = (await res.json()) as { data?: StatsLike };
    const d = body.data || {};
    if (d.total_seconds == null && d.is_up_to_date === false) return { ...base, ok: false, error: 'Stats are still being calculated' };
    return {
      ...base,
      ok: true,
      total_seconds: Math.round(d.total_seconds || 0),
      daily_average: Math.round(d.daily_average || 0),
      languages: (d.languages || []).slice(0, 3).map((l) => l.name),
    };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).name === 'TimeoutError' ? 'Timed out' : "Couldn't reach it" };
  }
}

export async function leaderboard(
  db: D1Database,
  friends: Friend[],
  range: string,
  you: { name: string; total_seconds: number; daily_average: number; languages: { name: string }[] },
  origin: string,
): Promise<Row[]> {
  const key = `friends:${range}:${JSON.stringify(friends)}`;
  const now = Math.floor(Date.now() / 1000);
  let rows: Row[] | null = null;
  const hit = await db.prepare('SELECT value FROM cache WHERE key = ?1 AND expires > ?2').bind(key, now).first<{ value: string }>();
  if (hit) rows = JSON.parse(hit.value);
  if (!rows) {
    rows = await Promise.all(friends.map((f) => friendRow(f, range)));
    await db
      .prepare('INSERT INTO cache (key, value, expires) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires')
      .bind(key, JSON.stringify(rows), now + TTL)
      .run();
  }
  const me: Row = {
    name: you.name,
    url: origin,
    profile: `${origin}/profile/`,
    source: 'you',
    ok: true,
    total_seconds: you.total_seconds,
    daily_average: you.daily_average,
    languages: you.languages.slice(0, 3).map((l) => l.name),
  };
  return [me, ...rows].sort((a, b) => Number(b.ok) - Number(a.ok) || b.total_seconds - a.total_seconds);
}
