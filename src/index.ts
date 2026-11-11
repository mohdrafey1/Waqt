import { Hono } from 'hono';
import { retryForwardQueue } from './forward';
import { type AppEnv, configuredKey } from './http';
import { badges, cards } from './routes/cards';
import { api } from './routes/api';
import { Env, loadSettings, saveSettings } from './settings';
import { flushDirty, markAllRawDaysDirty, pruneRaw } from './summaries';

const app = new Hono<AppEnv>();

app.route('/api/v1', api);
app.route('/api', api);
app.route('/card', cards);
app.route('/badge', badges);

app.get('/health', (c) => c.json({ ok: true, configured: !!configuredKey(c.env) }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error', detail: String(err?.message || err) }, 500);
});

export default {
  fetch: app.fetch,
  // Every 15 minutes: finish any pending day summaries; once a day: prune old raw data.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const s = await loadSettings(env.DB);
        if (s.needs_rebuild) {
          // After an upgrade that adds new kinds of totals, rebuild days we still have raw data for.
          await markAllRawDaysDirty(env, s);
          await saveSettings(env.DB, { needs_rebuild: '0' });
        }
        await flushDirty(env, s, 5);
        await pruneRaw(env, s);
        await retryForwardQueue(env, s);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

