// Optional: pass every heartbeat on to WakaTime (or any WakaTime-compatible server),
// so you can use Waqt and keep your WakaTime account, profile and integrations too.
// Turn it on by adding a WAKATIME_API_KEY secret to the Worker.

import { Env, Settings, saveSettings } from './settings';

const DEFAULT_URL = 'https://api.wakatime.com/api/v1';
const BATCH = 10; // same batch size the official wakatime-cli uses

export function forwardingEnabled(env: Env): boolean {
  return !!(env.WAKATIME_API_KEY || '').trim();
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

/**
 * Sends the heartbeats exactly as the editor sent them (AI fields, dependencies,
 * line numbers and all), with the same user agent, machine name and time zone.
 */
export async function forwardHeartbeats(
  env: Env,
  s: Settings,
  items: unknown[],
  headers: { ua: string; machine: string; tz: string },
): Promise<void> {
  const key = (env.WAKATIME_API_KEY || '').trim();
  if (!key || !items.length) return;

  const url = `${forwardTarget(env)}/users/current/heartbeats.bulk`;
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + btoa(key),
  };
  if (headers.ua) h['User-Agent'] = headers.ua;
  if (headers.machine) h['X-Machine-Name'] = headers.machine;
  if (headers.tz) h['Timezone'] = headers.tz;

  let error = '';
  for (let i = 0; i < items.length; i += BATCH) {
    try {
      const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(items.slice(i, i + BATCH)) });
      await res.arrayBuffer().catch(() => null);
      if (!res.ok) {
        error =
          res.status === 401
            ? 'WakaTime rejected the key (401). Check the WAKATIME_API_KEY secret.'
            : `WakaTime answered with status ${res.status}.`;
      }
    } catch (e) {
      error = `Could not reach ${forwardHost(env)}: ${String((e as Error)?.message || e)}`;
    }
  }

  // Only write when the status changes, to keep D1 writes low.
  const failing = !!s.forward_error;
  if (error && !failing) await saveSettings(env.DB, { forward_error: `${new Date().toISOString()} ${error}` });
  else if (!error && failing) await saveSettings(env.DB, { forward_error: '' });
}
