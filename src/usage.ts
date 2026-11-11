// Estimated free-plan usage. Every D1 result reports rows read/written and the
// database size; we add them up per UTC day (limits reset at 00:00 UTC) and save
// the running totals about once a minute, so tracking costs ~1 write per minute.
// Counts held in memory are lost if Cloudflare recycles the Worker, so the
// numbers are slightly low: good enough to warn well before a limit is reached.

export const LIMITS = {
  requests: 100_000, // Workers free plan, per day
  rows_read: 5_000_000, // D1 free plan, per day
  rows_written: 100_000, // D1 free plan, per day
  db_bytes: 500 * 1024 * 1024, // D1 free plan, per database
};

type Meta = { rows_read?: number; rows_written?: number; size_after?: number };

const acc = { day: '', requests: 0, reads: 0, writes: 0, size: 0, lastFlush: 0 };
const ORIGINAL = Symbol('original');

const utcDay = () => new Date().toISOString().slice(0, 10);

function record(meta: Meta | undefined) {
  if (!meta) return;
  acc.reads += meta.rows_read || 0;
  acc.writes += meta.rows_written || 0;
  if (meta.size_after) acc.size = meta.size_after;
}

function wrapStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  const wrapped: any = {
    [ORIGINAL]: stmt,
    bind: (...args: unknown[]) => wrapStatement(stmt.bind(...args)),
    async all() {
      const r = await stmt.all();
      record(r.meta as Meta);
      return r;
    },
    async run() {
      const r = await stmt.run();
      record(r.meta as Meta);
      return r;
    },
    // first() has no meta, so run all() and pick the first row.
    async first(column?: string) {
      const r = await stmt.all();
      record(r.meta as Meta);
      const row = (r.results[0] as Record<string, unknown> | undefined) ?? null;
      return column ? (row ? row[column] ?? null : null) : row;
    },
    raw: (...args: any[]) => (stmt as any).raw(...args),
  };
  return wrapped as D1PreparedStatement;
}

/** A D1 handle that counts rows read/written for the usage meter. */
export function trackDb(db: D1Database): D1Database {
  return {
    prepare: (sql: string) => wrapStatement(db.prepare(sql)),
    async batch(stmts: D1PreparedStatement[]) {
      const out = await db.batch(stmts.map((s: any) => s[ORIGINAL] || s));
      for (const r of out) record(r.meta as Meta);
      return out;
    },
    exec: (sql: string) => db.exec(sql),
    dump: () => (db as any).dump(),
    withSession: (...a: any[]) => (db as any).withSession(...a),
  } as unknown as D1Database;
}

export function countRequest() {
  const day = utcDay();
  if (acc.day && acc.day !== day) {
    // New UTC day: drop what wasn't saved rather than adding it to the wrong day.
    acc.requests = acc.reads = acc.writes = 0;
  }
  acc.day = day;
  acc.requests++;
}

/** Save the running totals if a minute has passed (or if forced). */
export async function flushUsage(db: D1Database, force = false): Promise<void> {
  const now = Date.now();
  if (!acc.day || (!force && now - acc.lastFlush < 60_000 && acc.writes < 1000)) return;
  const { day, requests, reads, writes, size } = acc;
  acc.requests = acc.reads = acc.writes = 0;
  acc.lastFlush = now;
  try {
    await db
      .prepare(
        `INSERT INTO usage_daily (day, requests, rows_read, rows_written, db_size) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests, rows_read = rows_read + excluded.rows_read,
           rows_written = rows_written + excluded.rows_written, db_size = CASE WHEN excluded.db_size > 0 THEN excluded.db_size ELSE db_size END`,
      )
      .bind(day, requests, reads, writes + 1, size)
      .run();
  } catch {
    // Table may not exist yet during the very first migration; try again later.
    acc.requests += requests;
    acc.reads += reads;
    acc.writes += writes;
  }
}

/** Saved totals plus what this Worker instance hasn't saved yet. */
export async function usageReport(db: D1Database) {
  const { results } = await db
    .prepare('SELECT day, requests, rows_read, rows_written, db_size FROM usage_daily ORDER BY day DESC LIMIT 7')
    .all<{ day: string; requests: number; rows_read: number; rows_written: number; db_size: number }>();
  const today = utcDay();
  const saved = results.find((r) => r.day === today) || { day: today, requests: 0, rows_read: 0, rows_written: 0, db_size: 0 };
  const pending = acc.day === today ? acc : { requests: 0, reads: 0, writes: 0 };
  const current = {
    day: today,
    requests: saved.requests + pending.requests,
    rows_read: saved.rows_read + pending.reads,
    rows_written: saved.rows_written + pending.writes,
  };
  const dbSize = acc.size || results.find((r) => r.db_size)?.db_size || 0;
  const pct = (v: number, max: number) => Math.round((v / max) * 1000) / 10;
  return {
    today: current,
    db_size: dbSize,
    limits: LIMITS,
    percent: {
      requests: pct(current.requests, LIMITS.requests),
      rows_read: pct(current.rows_read, LIMITS.rows_read),
      rows_written: pct(current.rows_written, LIMITS.rows_written),
      db_size: pct(dbSize, LIMITS.db_bytes),
    },
    history: results.map((r) => (r.day === today ? { ...r, ...current } : r)),
  };
}
