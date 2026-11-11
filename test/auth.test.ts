import { describe, expect, it } from 'vitest';
import { auth, beats, call, json, post } from './helpers';

const jsonBody = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const basic = (k: string) => ({ Authorization: 'Basic ' + btoa(k) });

async function login(secret: string, ip = '203.0.113.1') {
  const res = await call('/api/v1/auth/login', jsonBody({ secret }, { 'CF-Connecting-IP': ip }));
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  return { status: res.status, cookie, body: (await res.json()) as any, setCookie: res.headers.get('Set-Cookie') || '' };
}

describe('device keys', () => {
  it('can send activity and read stats, but nothing else', async () => {
    const created = await post('/api/v1/users/current/keys', { name: 'Work laptop' });
    expect(created.status).toBe(201);
    const key = created.body.data.key as string;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    const sent = await post('/api/v1/users/current/heartbeats.bulk', beats(2, { project: 'device', endAgo: 66000 }), basic(key));
    expect(sent.status).toBe(202);
    expect((await json('/api/v1/users/current/statusbar/today', { headers: basic(key) })).status).toBe(200);
    expect((await json('/api/v1/users/current/stats/last_7_days', { headers: basic(key) })).status).toBe(200);
    expect((await json('/api/v1/users/current/settings', { headers: basic(key) })).status).toBe(403);
    expect((await json('/api/v1/users/current/keys', { headers: basic(key) })).status).toBe(403);
    expect((await json('/api/v1/users/current/backup', { headers: basic(key) })).status).toBe(403);

    // Listed without the key itself, then revoked.
    const list = (await json('/api/v1/users/current/keys', { headers: auth })).body.data;
    const row = list.find((k: any) => k.name === 'Work laptop');
    expect(row.hint).toBe(key.slice(-4));
    expect(JSON.stringify(list)).not.toContain(key);
    expect(row.last_used).toBeGreaterThan(0);
    expect((await json(`/api/v1/users/current/keys/${row.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await json('/api/v1/users/current/statusbar/today', { headers: basic(key) })).status).toBe(401);
  });

  it('cannot open the dashboard', async () => {
    const key = (await post('/api/v1/users/current/keys', { name: 'x' })).body.data.key;
    const r = await login(key, '203.0.113.9');
    expect(r.status).toBe(401);
    expect(r.body.error).toContain('device key');
  });
});

describe('dashboard sign-in', () => {
  it('signs in with a password into an HttpOnly session', async () => {
    const set = await json('/api/v1/users/current/password', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    expect(set.status).toBe(200);
    expect((await json('/api/v1/auth/status')).body.data.password_set).toBe(true);
    expect(JSON.stringify((await json('/api/v1/users/current/settings', { headers: auth })).body)).not.toContain('pbkdf2');

    expect((await login('wrong password!')).status).toBe(401);
    const ok = await login('correct horse battery');
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/HttpOnly/i);
    expect(ok.setCookie).toMatch(/SameSite=Strict/i);
    expect(ok.setCookie).toMatch(/Secure/i);

    // The cookie alone isn't enough: the page must add X-Waqt (CSRF protection).
    expect((await json('/api/v1/users/current/settings', { headers: { Cookie: ok.cookie } })).status).toBe(401);
    const withHeader = { Cookie: ok.cookie, 'X-Waqt': '1' };
    expect((await json('/api/v1/users/current/settings', { headers: withHeader })).status).toBe(200);
    expect((await json('/api/v1/auth/status', { headers: withHeader })).body.data.signed_in).toBe(true);

    const sessions = (await json('/api/v1/users/current/sessions', { headers: withHeader })).body.data;
    expect(sessions.some((x: any) => x.current)).toBe(true);

    await call('/api/v1/auth/logout', { method: 'POST', headers: withHeader });
    expect((await json('/api/v1/users/current/settings', { headers: withHeader })).status).toBe(401);
  });

  it('also accepts the main key, and limits password guessing', async () => {
    expect((await login('0f8fad5b-d9cb-469f-a165-70867728950e', '198.51.100.7')).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login('guess number ' + i, '198.51.100.8')).status;
    expect(last).toBe(429);
    // The main key still works from a blocked address.
    expect((await login('0f8fad5b-d9cb-469f-a165-70867728950e', '198.51.100.8')).status).toBe(200);
  });

  it('rejects short passwords and can remove the password', async () => {
    const short = await json('/api/v1/users/current/password', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'short' }) });
    expect(short.status).toBe(400);
    await json('/api/v1/users/current/password', { method: 'DELETE', headers: auth });
    expect((await json('/api/v1/auth/status')).body.data.password_set).toBe(false);
  });
});
