// Re-reading stored heartbeats when the user-agent parser improves.

import { Env, Settings, saveSettings } from './settings';
import { markAllRawDaysDirty } from './summaries';
import { PARSER_VERSION, parseUserAgent } from './useragent';

/**
 * Re-parse every stored user agent and fix heartbeats whose editor, OS or AI model
 * comes out differently. Only rows that actually change are written, so this stays
 * well inside the free plan's daily write allowance. Returns the number of rows changed.
 */
export async function reparseUserAgents(env: Env, s: Settings): Promise<number> {
  const { results } = await env.DB.prepare('SELECT id, value FROM user_agents').all<{ id: number; value: string }>();
  let changed = 0;
  for (let i = 0; i < results.length; i += 25) {
    const stmts = results.slice(i, i + 25).map((u) => {
      const p = parseUserAgent(u.value);
      return env.DB.prepare(
        `UPDATE heartbeats SET editor = ?2, os = ?3, ai_model = CASE WHEN ?4 != '' THEN ?4 ELSE ai_model END
         WHERE user_agent_id = ?1 AND (editor != ?2 OR os != ?3 OR (?4 != '' AND ai_model != ?4))`,
      ).bind(u.id, p.editor, p.os, p.model);
    });
    const out = await env.DB.batch(stmts);
    changed += out.reduce((a, r) => a + (r.meta?.changes || 0), 0);
  }
  if (changed) await markAllRawDaysDirty(env, s);
  await saveSettings(env.DB, { parser_version: String(PARSER_VERSION) });
  s.parser_version = PARSER_VERSION;
  return changed;
}
