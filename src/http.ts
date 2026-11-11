import type { Context, MiddlewareHandler } from 'hono';
import { type Auth, isKeyShaped, resolveAuth } from './auth';
import { ensureMigrated } from './migrate';
import { Env, Settings, loadSettings } from './settings';
import type { View } from './stats';

export type Vars = { settings: Settings; auth?: Auth };
export type AppEnv = { Bindings: Env; Variables: Vars };
export type C = Context<AppEnv>;

export function configuredKey(env: Env): string | null {
  const k = (env.API_KEY || '').trim().toLowerCase().replace(/^waka_/, '');
  return isKeyShaped(k) ? k : null;
}

/** Owner (main key or dashboard session), device (per-editor key), or nobody. Cached per request. */
export async function authOf(c: C): Promise<Auth> {
  const cached = c.get('auth');
  if (cached !== undefined) return cached;
  const a = await resolveAuth(c, c.env, configuredKey(c.env));
  c.set('auth', a);
  return a;
}

export const withSettings: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await ensureMigrated(c.env.DB);
    c.set('settings', await loadSettings(c.env.DB));
  } catch (e) {
    const detail = String(e);
    if (/exceeded|limit/i.test(detail)) {
      // Free plan daily limit: editors keep heartbeats offline and resend them on a 5xx.
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      c.header('Retry-After', String(Math.max(60, Math.ceil((reset.getTime() - Date.now()) / 1000))));
      return c.json(
        {
          error: `Cloudflare's free daily database limit is used up. It resets at ${reset.toISOString().slice(11, 16)} UTC; editors keep your activity and send it then.`,
          detail,
        },
        503,
      );
    }
    return c.json({ error: 'Database is not ready. Check that the D1 database is bound as DB, then redeploy.', detail }, 500);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!configuredKey(c.env)) {
    return c.json(
      { error: 'API_KEY secret is missing or is not a lowercase UUID v4. Set it in the Cloudflare dashboard → your Worker → Settings → Variables and Secrets.' },
      500,
    );
  }
  const a = await authOf(c);
  if (a === 'device') return c.json({ error: 'This key can only send activity. Sign in to the dashboard or use the main key.' }, 403);
  if (a !== 'owner') return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

/** The WakaTime-compatible endpoints editors use: any valid key or a session. */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!configuredKey(c.env)) return c.json({ error: 'API_KEY secret is missing or is not a lowercase UUID v4.' }, 500);
  if (!(await authOf(c))) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

export function cors(c: C) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
}

/** "current" needs the key and gets everything; any other username gets the public view. */
export async function viewFor(c: C): Promise<View | 'denied' | 'unauthorized'> {
  const user = c.req.param('user');
  if (user === 'current') return (await authOf(c)) ? 'private' : 'unauthorized';
  return c.get('settings').public_enabled ? 'public' : 'denied';
}

