import { createExecutionContext, env as testEnv, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/settings';

export const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const env = testEnv as unknown as Env;
export const auth = { Authorization: 'Basic ' + btoa(KEY) };

/** Call the Worker directly (same isolate, so vi.spyOn(globalThis, 'fetch') sees outbound calls). */
export async function call(path: string, init: RequestInit = {}, extraEnv: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request('https://waqt.test' + path, init) as any, { ...env, ...extraEnv } as any, ctx);
  await waitOnExecutionContext(ctx);
  return res as unknown as Response;
}

export async function json<T = any>(path: string, init: RequestInit = {}, extraEnv: Partial<Env> = {}): Promise<{ status: number; body: T }> {
  const res = await call(path, init, extraEnv);
  return { status: res.status, body: (await res.json()) as T };
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}, extraEnv: Partial<Env> = {}) {
  return json(path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, extraEnv);
}

export function put(path: string, body: unknown) {
  return json(path, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export const UA = 'wakatime/v2.28.4 (darwin-24.1.0-arm64) go1.25.0 vscode/1.95.0 vscode-wakatime/25.0.0';

/** n heartbeats `gap` seconds apart, ending `endAgo` seconds before now. */
export function beats(n: number, opts: { gap?: number; endAgo?: number; project?: string; language?: string; extra?: Record<string, unknown> } = {}) {
  const gap = opts.gap ?? 120;
  const end = Math.floor(Date.now() / 1000) - (opts.endAgo ?? 60);
  return Array.from({ length: n }, (_, i) => ({
    time: end - (n - 1 - i) * gap,
    entity: `/code/${opts.project || 'demo'}/file${i % 3}.ts`,
    type: 'file',
    category: 'coding',
    project: opts.project || 'demo',
    language: opts.language || 'TypeScript',
    is_write: i % 2 === 0,
    user_agent: UA,
    ...(opts.extra || {}),
  }));
}

/** Run the cron job once. */
export async function cron() {
  const ctx = createExecutionContext();
  await worker.scheduled!({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
}
