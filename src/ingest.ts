import { Env, Settings, saveSettings, tzOf } from './settings';
import { markDaysDirty } from './summaries';
import { dayOf, isValidTimeZone } from './time';
import { parseUserAgent } from './useragent';

type Row = [
  number, // 0 time
  string, // 1 entity
  string, // 2 type
  string, // 3 category
  string, // 4 project
  string, // 5 branch
  string, // 6 language
  string, // 7 editor
  string, // 8 os
  string, // 9 machine
  number, // 10 is_write
  number | null, // 11 lines
  number | null, // 12 ai_line_changes
  number | null, // 13 human_line_changes
  string, // 14 ai_model
  string, // 15 ai_session
  number | null, // 16 ai_input_tokens
  number | null, // 17 ai_output_tokens
  number | null, // 18 ai_cached_input_tokens
  number | null, // 19 ai_prompt_length
];

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

const MIN_TIME = 946684800; // 2000-01-01

export function normalize(raw: any, machine: string, fallbackUa: string): Row | null {
  if (!raw || typeof raw !== 'object') return null;
  const time = Number(raw.time);
  if (!Number.isFinite(time) || time < MIN_TIME || time > Date.now() / 1000 + 86400) return null;
  const entity = str(raw.entity, 512);
  if (!entity) return null;
  const { editor, os, model } = parseUserAgent(str(raw.user_agent, 400) || fallbackUa);
  return [
    Math.round(time * 1e6) / 1e6,
    entity,
    str(raw.type, 20) || 'file',
    (str(raw.category, 40) || 'coding').toLowerCase(),
    str(raw.project),
    str(raw.branch),
    str(raw.language, 60),
    editor,
    os,
    machine,
    raw.is_write ? 1 : 0,
    int(raw.lines),
    int(raw.ai_line_changes),
    int(raw.human_line_changes),
    model || str(raw.ai_model, 60),
    str(raw.ai_session, 100),
    int(raw.ai_input_tokens),
    int(raw.ai_output_tokens),
    int(raw.ai_cached_input_tokens),
    int(raw.ai_prompt_length),
  ];
}

export const INSERT_SQL = `INSERT OR IGNORE INTO heartbeats
  (time, entity, type, category, project, branch, language, editor, os, machine, is_write, lines, ai_line_changes, human_line_changes, ai_model, ai_session, ai_input_tokens, ai_output_tokens, ai_cached_tokens, ai_prompt_length)
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]'), json_extract(value, '$[10]'), json_extract(value, '$[11]'), json_extract(value, '$[12]'), json_extract(value, '$[13]'), json_extract(value, '$[14]'), json_extract(value, '$[15]'), json_extract(value, '$[16]'), json_extract(value, '$[17]'), json_extract(value, '$[18]'), json_extract(value, '$[19]')
  FROM json_each(?1)`;

export const MAX_BATCH = 1000;

/** Store heartbeats and return the per-heartbeat responses the WakaTime CLI expects. */
export async function ingest(
  env: Env,
  s: Settings,
  items: unknown[],
  headers: { machine: string; ua: string; tz: string },
): Promise<{ responses: [unknown, number][] }> {
  // First heartbeat ever: adopt the time zone the CLI reports.
  if (!s.timezone && isValidTimeZone(headers.tz)) {
    await saveSettings(env.DB, { timezone: headers.tz });
    s.timezone = headers.tz;
  }
  const tz = tzOf(s);
  const timeout = s.timeout_minutes * 60;
  const machine = headers.machine.slice(0, 100);

  const rows: Row[] = [];
  const days = new Set<string>();
  const responses: [unknown, number][] = [];

  for (const raw of items.slice(0, MAX_BATCH)) {
    const row = normalize(raw, machine, headers.ua);
    if (!row) {
      responses.push([{ error: 'invalid heartbeat' }, 400]);
      continue;
    }
    rows.push(row);
    days.add(dayOf(row[0], tz));
    // A heartbeat just after midnight also changes how long yesterday's last session ran.
    days.add(dayOf(row[0] - timeout, tz));
    responses.push([{ data: { id: `${row[0]}`, time: row[0], entity: row[1] } }, 201]);
  }

  if (rows.length) {
    await env.DB.prepare(INSERT_SQL).bind(JSON.stringify(rows)).run();
    await markDaysDirty(env, [...days]);
    // Remember when Waqt's own data starts, so WakaTime imports never double count.
    if (!s.first_heartbeat) {
      const first = Math.min(...rows.map((r) => r[0]));
      await saveSettings(env.DB, { first_heartbeat: String(first) });
      s.first_heartbeat = first;
    }
  }
  return { responses };
}
