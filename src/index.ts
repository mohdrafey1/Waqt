import { Hono } from 'hono';
import { type AppEnv, configuredKey } from './http';
import { badges, cards } from './routes/cards';
import { api } from './routes/api';
import { Env, loadSettings } from './settings';
import { flushDirty, pruneRaw } from './summaries';

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
        await flushDirty(env, s, 10);
        await pruneRaw(env, s);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

