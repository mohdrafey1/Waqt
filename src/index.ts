import { Hono } from 'hono';
import { retryForwardQueue } from './forward';
import { maybeSendWeekly } from './report';
import { maybeNudge } from './nudges';
import { VERSION, checkForUpdate } from './version';
import { type AppEnv, configuredKey } from './http';
import { reparseUserAgents } from './maintenance';
import { countRequest, flushUsage, trackDb } from './usage';
import { ensureMigrated } from './migrate';
import { PARSER_VERSION } from './useragent';
import { badges, cards } from './routes/cards';
import { api } from './routes/api';
import { Env, loadSettings, saveSettings } from './settings';
import { flushDirty, markAllRawDaysDirty, pruneRaw } from './summaries';

const app = new Hono<AppEnv>();

app.route('/api/v1', api);
app.route('/api', api);
app.route('/card', cards);
app.route('/badge', badges);

app.get('/health', (c) => c.json({ ok: true, configured: !!configuredKey(c.env), version: VERSION }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error', detail: String(err?.message || err) }, 500);
});

export default {
  // Every request goes through a D1 handle that counts rows for the usage meter.
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    countRequest();
    const raw = env.DB;
    const res = await app.fetch(request, { ...env, DB: trackDb(raw) }, ctx);
    ctx.waitUntil(flushUsage(raw));
    return res;
  },
  // Every 15 minutes: finish any pending day summaries; once a day: prune old raw data.
  async scheduled(_event: ScheduledController, rawEnv: Env, ctx: ExecutionContext) {
    countRequest();
    const env = { ...rawEnv, DB: trackDb(rawEnv.DB) };
    ctx.waitUntil(
      (async () => {
        await ensureMigrated(env.DB);
        const s = await loadSettings(env.DB);
        if (s.needs_rebuild) {
          // After an upgrade that adds new kinds of totals, rebuild days we still have raw data for.
          await markAllRawDaysDirty(env, s);
          await saveSettings(env.DB, { needs_rebuild: '0' });
        }
        if (s.parser_version !== PARSER_VERSION) await reparseUserAgents(env, s);
        await flushDirty(env, s, 5);
        await pruneRaw(env, s);
        await retryForwardQueue(env, s);
        await maybeSendWeekly(env, s);
        await maybeNudge(env, s).catch((e) => console.error('nudge failed', e));
        await checkForUpdate(env, s);
        await flushUsage(rawEnv.DB, true);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

