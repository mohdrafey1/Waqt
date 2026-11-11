import type { Context, MiddlewareHandler } from 'hono';
import { Env, Settings, loadSettings } from './settings';
import type { View } from './stats';

export type Vars = { settings: Settings };
export type AppEnv = { Bindings: Env; Variables: Vars };
export type C = Context<AppEnv>;

const KEY_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function configuredKey(env: Env): string | null {
  const k = (env.API_KEY || '').trim().toLowerCase().replace(/^waka_/, '');
  return KEY_RE.test(k) ? k : null;
}

function presentedKeys(c: C): string[] {
  const out: string[] = [];
  const h = c.req.header('Authorization') || '';
  if (/^basic /i.test(h)) {
    try {
      const decoded = atob(h.slice(6).trim());
      out.push(decoded, ...decoded.split(':'));
    } catch {}
  } else if (/^bearer /i.test(h)) {
    out.push(h.slice(7).trim());
  }
  const q = c.req.query('api_key');
  if (q) out.push(q);
  return out.map((k) => k.trim().toLowerCase().replace(/^waka_/, '')).filter(Boolean);
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export function isAuthed(c: C): boolean {
  const key = configuredKey(c.env);
  if (!key) return false;
  return presentedKeys(c).some((k) => safeEqual(k, key));
}

export const withSettings: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    c.set('settings', await loadSettings(c.env.DB));
  } catch (e) {
    return c.json(
      { error: 'Database is not ready. Run `npm run db:local` (local) or redeploy so migrations apply.', detail: String(e) },
      500,
    );
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
  if (!isAuthed(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

export function cors(c: C) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
}

/** "current" needs the key and gets everything; any other username gets the public view. */
export function viewFor(c: C): View | 'denied' | 'unauthorized' {
  const user = c.req.param('user');
  if (user === 'current') return isAuthed(c) ? 'private' : 'unauthorized';
  return c.get('settings').public_enabled ? 'public' : 'denied';
}

