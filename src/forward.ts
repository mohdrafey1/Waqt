// Optional: pass every heartbeat on to WakaTime (or any WakaTime-compatible server),
// so you can use Waqt and keep your WakaTime account, profile and integrations too.
// Turn it on by adding a WAKATIME_API_KEY secret to the Worker.
//
// If WakaTime can't be reached, the batch is queued in D1 and the cron job retries it
// with growing delays, so nothing is lost during an outage.

import { Env, Settings, saveSettings } from './settings';

const DEFAULT_URL = 'https://api.wakatime.com/api/v1';
const BATCH = 10; // same batch size the official wakatime-cli uses
const MAX_QUEUE = 5000; // batches; oldest are dropped beyond this
const MAX_AGE = 14 * 86400; // give up on a batch after two weeks
const RETRIES_PER_RUN = 10;

type Headers = { ua: string; machine: string; tz: string };

export function forwardKey(env: Env): string {
  return (env.WAKATIME_API_KEY || '').trim();
}

/** Forwarding runs when the secret is set and the dashboard switch is on. */
export function forwardingEnabled(env: Env, s?: Settings): boolean {
  return !!forwardKey(env) && (s ? s.forward_enabled : true);
}

export function forwardTarget(env: Env): string {
  return (env.WAKATIME_API_URL || DEFAULT_URL).trim().replace(/\/+$/, '');
}

export function forwardHost(env: Env): string {
  try {
    return new URL(forwardTarget(env)).host;
  } catch {
    return 'invalid WAKATIME_API_URL';
  }
}

type SendResult = { ok: true } | { ok: false; retry: boolean; error: string };

async function send(env: Env, body: string, headers: Headers): Promise<SendResult> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + btoa(forwardKey(env)),
  };
  if (headers.ua) h['User-Agent'] = headers.ua;
  if (headers.machine) h['X-Machine-Name'] = headers.machine;
  if (headers.tz) h['Timezone'] = headers.tz;
  try {
    const res = await fetch(`${forwardTarget(env)}/users/current/heartbeats.bulk`, { method: 'POST', headers: h, body });
    await res.arrayBuffer().catch(() => null);
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      // Keep the data: it can be delivered once the key is fixed.
      return { ok: false, retry: true, error: `WakaTime rejected the key (${res.status}). Check the WAKATIME_API_KEY secret.` };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retry: true, error: `WakaTime answered with status ${res.status}; will retry.` };
    }
    return { ok: false, retry: false, error: `WakaTime refused the heartbeats (status ${res.status}).` };
  } catch (e) {
    return { ok: false, retry: true, error: `Could not reach ${forwardHost(env)}: ${String((e as Error)?.message || e)}` };
  }
}

const backoff = (attempts: number) => Math.min(6 * 3600, 60 * 2 ** attempts);

async function setStatus(env: Env, s: Settings, error: string): Promise<void> {
  // Only write when the status changes, to keep D1 writes low.
  if (error && !s.forward_error) await saveSettings(env.DB, { forward_error: `${new Date().toISOString()} ${error}` });
  else if (!error && s.forward_error) await saveSettings(env.DB, { forward_error: '' });
  s.forward_error = error;
}

/**
 * Sends the heartbeats exactly as the editor sent them (AI fields, dependencies,
 * line numbers and all), with the same user agent, machine name and time zone.
 */
export async function forwardHeartbeats(env: Env, s: Settings, items: unknown[], headers: Headers): Promise<void> {
  if (!forwardingEnabled(env, s) || !items.length) return;
  let error = '';
  const queue: string[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const body = JSON.stringify(items.slice(i, i + BATCH));
    const r = await send(env, body, headers);
    if (!r.ok) {
      error = r.error;
      if (r.retry) queue.push(body);
    }
  }
  if (queue.length) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO forward_queue (body, headers, attempts, created_at, next_at, last_error)
       SELECT value, ?2, 0, ?5, ?3, ?4 FROM json_each(?1)`,
    )
      .bind(JSON.stringify(queue), JSON.stringify(headers), now + backoff(0), error, now)
      .run();
  }
  await setStatus(env, s, error);
}

/** Cron: retry queued batches that are due. */
export async function retryForwardQueue(env: Env, s: Settings): Promise<{ sent: number; failed: number; pending: number }> {
  const now = Math.floor(Date.now() / 1000);
  if (!forwardingEnabled(env, s)) return { sent: 0, failed: 0, pending: await forwardQueueSize(env) };
  const { results } = await env.DB.prepare(
    'SELECT id, body, headers, attempts FROM forward_queue WHERE next_at <= ?1 ORDER BY id LIMIT ?2',
  )
    .bind(now, RETRIES_PER_RUN)
    .all<{ id: number; body: string; headers: string; attempts: number }>();
  if (!results.length) return { sent: 0, failed: 0, pending: await forwardQueueSize(env) };

  const done: number[] = [];
  const stmts: D1PreparedStatement[] = [];
  let lastError = '';
  for (const row of results) {
    let headers: Headers = { ua: '', machine: '', tz: '' };
    try {
      headers = JSON.parse(row.headers);
    } catch {}
    const r = await send(env, row.body, headers);
    if (r.ok || !r.retry) {
      done.push(row.id);
      if (!r.ok) lastError = r.error;
    } else {
      lastError = r.error;
      stmts.push(
        env.DB.prepare('UPDATE forward_queue SET attempts = attempts + 1, next_at = ?2, last_error = ?3 WHERE id = ?1').bind(
          row.id,
          now + backoff(row.attempts + 1),
          r.error,
        ),
      );
    }
  }
  if (done.length) stmts.push(env.DB.prepare('DELETE FROM forward_queue WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(done)));
  // Housekeeping: drop batches that kept failing for too long, and keep the queue bounded.
  stmts.push(env.DB.prepare('DELETE FROM forward_queue WHERE created_at < ?1').bind(now - MAX_AGE));
  stmts.push(
    env.DB.prepare('DELETE FROM forward_queue WHERE id NOT IN (SELECT id FROM forward_queue ORDER BY id DESC LIMIT ?1)').bind(MAX_QUEUE),
  );
  await env.DB.batch(stmts);
  await setStatus(env, s, done.length === results.length && !lastError ? '' : lastError);
  return { sent: done.length, failed: results.length - done.length, pending: await forwardQueueSize(env) };
}

export async function forwardQueueSize(env: Env): Promise<number> {
  const p = await env.DB.prepare('SELECT COUNT(*) AS n FROM forward_queue').first<{ n: number }>();
  return p?.n || 0;
}
