// Applies database migrations from inside the Worker if the deploy didn't.
//
// `npm run deploy` already runs `wrangler d1 migrations apply`, but a Worker can be
// deployed with a different command (for example `npx wrangler deploy`). Then the
// first request applies whatever is missing, recording it in the same
// `d1_migrations` table Wrangler uses, so Wrangler and the Worker never repeat
// each other's work.

import m0001 from '../migrations/0001_init.sql';
import m0002 from '../migrations/0002_hours_ai_import.sql';
import m0003 from '../migrations/0003_repair_plugin_quirks.sql';
import m0004 from '../migrations/0004_user_agents.sql';
import m0005 from '../migrations/0005_usage.sql';
import m0006 from '../migrations/0006_files.sql';
import m0007 from '../migrations/0007_auth.sql';

const MIGRATIONS: [string, string][] = [
  ['0001_init.sql', m0001],
  ['0002_hours_ai_import.sql', m0002],
  ['0003_repair_plugin_quirks.sql', m0003],
  ['0004_user_agents.sql', m0004],
  ['0005_usage.sql', m0005],
  ['0006_files.sql', m0006],
  ['0007_auth.sql', m0007],
];

let checked = false;

export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function ensureMigrated(db: D1Database): Promise<void> {
  if (checked) return;
  let applied = new Set<string>();
  try {
    const { results } = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
    applied = new Set(results.map((r) => r.name));
  } catch {
    // No migrations table yet: nothing has been applied.
  }
  const pending = MIGRATIONS.filter(([name]) => !applied.has(name));
  if (pending.length) {
    await db
      .prepare(
        'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
      )
      .run();
    for (const [name, sql] of pending) {
      const stmts = splitSql(sql).map((s) => db.prepare(s));
      stmts.push(db.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?1)').bind(name));
      try {
        await db.batch(stmts); // one transaction: all or nothing
      } catch (e) {
        // Another request may have applied it at the same moment.
        const done = await db.prepare('SELECT 1 AS ok FROM d1_migrations WHERE name = ?1').bind(name).first();
        if (!done) throw e;
      }
    }
  }
  checked = true;
}
