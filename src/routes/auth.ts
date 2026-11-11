// Dashboard sign-in, device keys and the dashboard password.
//
// POST   /auth/login              { secret } password or main key → session cookie
// POST   /auth/logout
// GET    /auth/status             { password_set, signed_in }
// GET    /users/current/keys      device keys (never the keys themselves)
// POST   /users/current/keys      { name } → { key } shown once
// DELETE /users/current/keys/:id  revoke
// PUT    /users/current/password  { password }  (signs out other browsers)
// DELETE /users/current/password
// GET    /users/current/sessions
// DELETE /users/current/sessions  sign out every other browser

import { Hono } from 'hono';
import {
  SESSION_DAYS,
  checkPassword,
  createSession,
  endSession,
  hashPassword,
  isKeyShaped,
  loginBlocked,
  newDeviceKey,
  recordLoginFailure,
  safeEqual,
  sessionId,
  sha256,
} from '../auth';
import { type AppEnv, authOf, configuredKey, requireAuth } from '../http';
import { saveSettings } from '../settings';

export const auth = new Hono<AppEnv>();

const ipOf = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('CF-Connecting-IP') || 'unknown';

auth.get('/status', async (c) => {
  const pw = await c.env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = 'dashboard_password' AND value != ''").first();
  return c.json({ data: { password_set: !!pw, signed_in: (await authOf(c)) === 'owner' } });
});

auth.post('/login', async (c) => {
  let body: { secret?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  if (!secret || secret.length > 500) return c.json({ error: 'Enter your password or key' }, 400);

  // The main key always works (it can't be guessed, so it isn't rate limited).
  const master = configuredKey(c.env);
  const asKey = secret.toLowerCase().replace(/^waka_/, '');
  if (master && safeEqual(asKey, master)) {
    await createSession(c, c.env);
    return c.json({ data: { ok: true, days: SESSION_DAYS } });
  }

  const ip = ipOf(c);
  if (await loginBlocked(c.env, ip)) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);

  const stored = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'dashboard_password'").first<{ value: string }>();
  if (stored?.value && (await checkPassword(secret, stored.value))) {
    await createSession(c, c.env);
    return c.json({ data: { ok: true, days: SESSION_DAYS } });
  }
  await recordLoginFailure(c.env, ip);
  if (isKeyShaped(asKey)) {
    const device = await c.env.DB.prepare('SELECT 1 AS x FROM api_keys WHERE hash = ?1 AND revoked_at = 0').bind(await sha256(asKey)).first();
    if (device) return c.json({ error: 'That is a device key, which can only send activity. Use your password or the main key.' }, 401);
  }
  return c.json({ error: stored?.value ? 'Wrong password or key.' : 'That key does not match this Waqt.' }, 401);
});

auth.post('/logout', async (c) => {
  await endSession(c, c.env);
  return c.json({ data: { ok: true } });
});

// ---------- owner only ----------

// Mounted at /users/current, so each route checks auth itself (a '*' middleware
// here would also catch the editor endpoints that live next to it).
export const account = new Hono<AppEnv>();

account.get('/keys', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, hint, created_at, last_used, revoked_at FROM api_keys ORDER BY revoked_at != 0, created_at DESC LIMIT 200',
  ).all();
  return c.json({ data: results });
});

account.post('/keys', requireAuth, async (c) => {
  let body: { name?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {}
  const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 60) || 'Device';
  const active = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at = 0').first<{ n: number }>();
  if ((active?.n || 0) >= 50) return c.json({ error: 'At most 50 active keys. Revoke one first.' }, 400);
  const key = newDeviceKey();
  const now = Math.floor(Date.now() / 1000);
  const r = await c.env.DB.prepare('INSERT INTO api_keys (name, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id')
    .bind(name, await sha256(key), key.slice(-4), now)
    .first<{ id: number }>();
  return c.json({ data: { id: r?.id, name, key, hint: key.slice(-4), created_at: now } }, 201);
});

account.delete('/keys/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'Bad id' }, 400);
  const r = await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1 AND revoked_at = 0')
    .bind(id, Math.floor(Date.now() / 1000))
    .run();
  if (!r.meta.changes) return c.json({ error: 'No such active key' }, 404);
  return c.json({ data: { ok: true } });
});

account.put('/password', requireAuth, async (c) => {
  let body: { password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 10) return c.json({ error: 'Use at least 10 characters.' }, 400);
  if (password.length > 200) return c.json({ error: 'At most 200 characters.' }, 400);
  await saveSettings(c.env.DB, { dashboard_password: await hashPassword(password) });
  // A new password signs out every other browser.
  const keep = (await sessionId(c)) || '';
  await c.env.DB.prepare('DELETE FROM sessions WHERE id != ?1').bind(keep).run();
  return c.json({ data: { ok: true } });
});

account.delete('/password', requireAuth, async (c) => {
  await saveSettings(c.env.DB, { dashboard_password: '' });
  return c.json({ data: { ok: true } });
});

account.get('/sessions', requireAuth, async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const current = (await sessionId(c)) || '';
  const { results } = await c.env.DB.prepare(
    'SELECT id, created_at, last_seen, user_agent FROM sessions WHERE expires_at > ?1 ORDER BY last_seen DESC LIMIT 50',
  )
    .bind(now)
    .all<{ id: string; created_at: number; last_seen: number; user_agent: string }>();
  return c.json({ data: results.map(({ id, ...r }) => ({ ...r, current: id === current })) });
});

account.delete('/sessions', requireAuth, async (c) => {
  const keep = (await sessionId(c)) || '';
  const r = await c.env.DB.prepare('DELETE FROM sessions WHERE id != ?1').bind(keep).run();
  return c.json({ data: { signed_out: r.meta.changes } });
});
