// The running version (kept in step with package.json; a test checks it) and a
// once-a-day look at the main repository for a newer one.

import { Env, Settings, saveSettings } from './settings';

export const VERSION = '1.2.1';
export const UPSTREAM = 'mohdrafey1/waqt';
const DEFAULT_URL = `https://raw.githubusercontent.com/${UPSTREAM}/main/package.json`;

/** Compare "1.10.0" and "1.9.2" properly. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export async function checkForUpdate(env: Env, s: Settings): Promise<void> {
  const url = env.WAQT_VERSION_URL ?? DEFAULT_URL;
  if (!url || url === 'off') return;
  const now = Math.floor(Date.now() / 1000);
  if (now - s.latest_checked < 86400) return;
  await saveSettings(env.DB, { latest_checked: String(now) }); // at most once a day, even if it fails
  try {
    const res = await fetch(url, { headers: { 'User-Agent': `Waqt/${VERSION}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const v = String(((await res.json()) as { version?: string }).version || '');
    if (/^\d+\.\d+\.\d+$/.test(v)) await saveSettings(env.DB, { latest_version: v });
  } catch {}
}

export function versionInfo(s: Settings) {
  return {
    version: VERSION,
    latest_version: s.latest_version || VERSION,
    update_available: !!s.latest_version && newer(s.latest_version, VERSION),
    changelog: `https://github.com/${UPSTREAM}/blob/main/CHANGELOG.md`,
  };
}
