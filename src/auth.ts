// Who is calling: the owner (main API key or a dashboard session) or a device
// (a per-editor key that can only send activity and read stats).
//
// - Device keys are random UUIDs (the WakaTime plugins need that shape). Only a
//   SHA-256 hash is stored, so a database copy doesn't reveal them.
// - The dashboard password is stored as PBKDF2-SHA256. Workers' free plan allows
//   ~10 ms of CPU per request, so the iteration count is modest; logins are rate
//   limited per IP and overall, which is what really stops guessing.
// - A session is a random token in an HttpOnly, Secure, SameSite=Strict cookie;
//   the database keeps only its hash. Requests authenticated by the cookie must
//   also send "X-Waqt: 1", which other sites can't add (CSRF protection).

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './settings';

export type Auth = 'owner' | 'device' | null;

export const SESSION_COOKIE = 'waqt_session';
export const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 10_000;
const KEY_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isKeyShaped = (k: string) => KEY_RE.test(k);

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// ---------- password ----------

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !salt || !hash) return false;
  const got = b64(await pbkdf2(password, unb64(salt), Math.min(100_000, Number(iter) || PBKDF2_ITERATIONS)));
  return safeEqual(got, hash);
}

// ---------- sessions ----------

export async function createSession(c: Context, env: Env): Promise<void> {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (ch) => ({ '+': '-', '/': '_', '=': '' })[ch]!);
  const now = Math.floor(Date.now() / 1000);
  const ua = (c.req.header('User-Agent') || '').slice(0, 200);
  await env.DB.prepare('INSERT INTO sessions (id, created_at, expires_at, last_seen, user_agent) VALUES (?1, ?2, ?3, ?2, ?4)')
    .bind(await sha256(token), now, now + SESSION_DAYS * 86400, ua)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function sessionId(c: Context): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? sha256(token) : null;
}

export async function endSession(c: Context, env: Env): Promise<void> {
  const id = await sessionId(c);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

// ---------- resolving a request ----------

function presentedKeys(c: Context): string[] {
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
  return [...new Set(out.map((k) => k.trim().toLowerCase().replace(/^waka_/, '')).filter(isKeyShaped))];
}

export async function resolveAuth(c: Context, env: Env, masterKey: string | null): Promise<Auth> {
  const keys = presentedKeys(c);
  if (masterKey && keys.some((k) => safeEqual(k, masterKey))) return 'owner';

  const sid = await sessionId(c);
  if (sid && c.req.header('X-Waqt') === '1') {
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare('SELECT last_seen FROM sessions WHERE id = ?1 AND expires_at > ?2').bind(sid, now).first<{ last_seen: number }>();
    if (row) {
      if (now - row.last_seen > 3600) await env.DB.prepare('UPDATE sessions SET last_seen = ?2 WHERE id = ?1').bind(sid, now).run();
      return 'owner';
    }
  }

  for (const k of keys.slice(0, 3)) {
    const row = await env.DB.prepare('SELECT id, last_used FROM api_keys WHERE hash = ?1 AND revoked_at = 0').bind(await sha256(k)).first<{ id: number; last_used: number }>();
    if (row) {
      const now = Math.floor(Date.now() / 1000);
      if (now - row.last_used > 3600) await env.DB.prepare('UPDATE api_keys SET last_used = ?2 WHERE id = ?1').bind(row.id, now).run();
      return 'device';
    }
  }
  return null;
}

// ---------- login rate limit ----------

const WINDOW = 15 * 60;
const PER_IP = 10;
const OVERALL = 100;

/** True if this IP (or everyone together) has failed too often recently. */
export async function loginBlocked(env: Env, ip: string): Promise<boolean> {
  const since = Math.floor(Date.now() / 1000) - WINDOW;
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ip = ?1 THEN failures END), 0) AS mine, COALESCE(SUM(failures), 0) AS overall
     FROM login_attempts WHERE window_start > ?2`,
  )
    .bind(ip, since)
    .first<{ mine: number; overall: number }>();
  return !!r && (r.mine >= PER_IP || r.overall >= OVERALL);
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE window_start <= ?1').bind(now - WINDOW),
    env.DB.prepare(
      `INSERT INTO login_attempts (ip, window_start, failures) VALUES (?1, ?2, 1)
       ON CONFLICT(ip) DO UPDATE SET failures = failures + 1`,
    ).bind(ip, now),
  ]);
}

export function newDeviceKey(): string {
  return crypto.randomUUID();
}
