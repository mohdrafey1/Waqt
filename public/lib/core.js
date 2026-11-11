// Shared by the Worker (live data) and the browser (WakaTime import), so both
// count time exactly the same way.

/**
 * @typedef {Object} Beat
 * @property {number} time        unix seconds
 * @property {string} project
 * @property {string} language
 * @property {string} editor
 * @property {string} os
 * @property {string} machine
 * @property {string} category
 * @property {string} [ai_model]
 * @property {string} [ai_session]
 * @property {number|null} [ai_input_tokens]
 * @property {number|null} [ai_output_tokens]
 * @property {number|null} [ai_cached_tokens]
 * @property {number|null} [ai_prompt_length]
 * @property {number|null} [ai_line_changes]
 * @property {number|null} [human_line_changes]
 */

/**
 * @typedef {Object} DaySummary
 * @property {Array<[string,string,string,string,string,string,number,number,number]>} rows
 *   [project, language, editor, os, machine, category, seconds, ai_lines, human_lines]
 * @property {Array<[number, number]>} hours  [hour 0-23, seconds]
 * @property {Array<[string,number,number,number,number,number,number,number]>} ai
 *   [model, seconds, sessions, prompts, input_tokens, output_tokens, cached_tokens, ai_lines]
 */

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Turn one day's heartbeats (sorted by time) into totals. Each heartbeat is credited
 * with the gap until the next one if that gap is within `timeout` seconds, the way
 * WakaTime counts time. Heartbeats at or after `end` are only used as the "next" one.
 *
 * @param {Beat[]} beats
 * @param {number} start  local midnight (unix seconds)
 * @param {number} end    next local midnight (unix seconds)
 * @param {number} timeout seconds
 * @returns {DaySummary}
 */
export function summarizeDay(beats, start, end, timeout) {
  /** @type {Map<string, any[]>} */
  const combos = new Map();
  const hours = new Array(24).fill(0);
  /** @type {Map<string, {seconds:number, sessions:Set<string>, prompts:number, inTok:number, outTok:number, cached:number, lines:number}>} */
  const ai = new Map();

  for (let i = 0; i < beats.length; i++) {
    const h = beats[i];
    if (h.time >= end) break;
    if (h.time < start) continue;
    const next = beats[i + 1];
    let credit = 0;
    if (next && next.time - h.time <= timeout) credit = Math.min(next.time, end) - h.time;

    const key = `${h.project}\u0000${h.language}\u0000${h.editor}\u0000${h.os}\u0000${h.machine}\u0000${h.category}`;
    let row = combos.get(key);
    if (!row) {
      row = [h.project, h.language, h.editor, h.os, h.machine, h.category, 0, 0, 0];
      combos.set(key, row);
    }
    row[6] += credit;
    row[7] += h.ai_line_changes || 0;
    row[8] += h.human_line_changes || 0;

    // Spread the credited time over the local hours it covers.
    let t = h.time;
    let left = credit;
    while (left > 0) {
      const hour = Math.min(23, Math.max(0, Math.floor((t - start) / 3600)));
      const hourEnd = start + (hour + 1) * 3600;
      const slice = hour === 23 ? left : Math.min(left, hourEnd - t);
      hours[hour] += slice;
      t += slice;
      left -= slice;
    }

    const isAi =
      !!h.ai_model ||
      !!h.ai_session ||
      !!h.ai_input_tokens ||
      !!h.ai_output_tokens ||
      !!h.ai_line_changes ||
      h.category === 'ai coding';
    if (isAi) {
      const model = h.ai_model || '';
      let a = ai.get(model);
      if (!a) {
        a = { seconds: 0, sessions: new Set(), prompts: 0, inTok: 0, outTok: 0, cached: 0, lines: 0 };
        ai.set(model, a);
      }
      // AI *time* is agent activity (WakaTime's "AI coding" category or a reported model);
      // AI-edited lines inside normal coding still count as lines, not time.
      if (h.category === 'ai coding' || h.ai_model) a.seconds += credit;
      if (h.ai_session) a.sessions.add(h.ai_session);
      if ((h.ai_prompt_length || 0) > 0) a.prompts++;
      a.inTok += h.ai_input_tokens || 0;
      a.outTok += h.ai_output_tokens || 0;
      a.cached += h.ai_cached_tokens || 0;
      a.lines += h.ai_line_changes || 0;
    }
  }

  return {
    rows: [...combos.values()]
      .filter((r) => r[6] > 0 || r[7] || r[8])
      .map((r) => {
        r[6] = round3(r[6]);
        return /** @type {any} */ (r);
      }),
    hours: hours.map((s, h) => /** @type {[number, number]} */ ([h, round3(s)])).filter(([, s]) => s > 0),
    ai: [...ai.entries()]
      .map(([model, a]) => /** @type {[string,number,number,number,number,number,number,number]} */ ([
        model,
        round3(a.seconds),
        a.sessions.size,
        a.prompts,
        a.inTok,
        a.outTok,
        a.cached,
        a.lines,
      ]))
      .filter((r) => r.slice(1).some((v) => v)),
  };
}

/** Turn an AI user-agent token like "opus/4.1-medium" into a friendly name. */
export function prettyModel(token) {
  if (!token) return '';
  const [family, version = ''] = token.split('/');
  const names = { gpt: 'GPT', o: 'o', glm: 'GLM' };
  const fam = names[family.toLowerCase()] ?? family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${fam} ${version}` : fam;
}

/** Group a model name into its family for charts: "Opus 4.1-medium" → "Opus". */
export function modelFamily(name) {
  return (name || '').split(' ')[0] || 'Unknown';
}
