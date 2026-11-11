import { describe, expect, it } from 'vitest';
import { addDays, dayOf, dayStart, summarizeDay } from '../public/lib/core.js';
import { parseUserAgent } from '../src/useragent';
import { durationText, resolveRange } from '../src/time';

const beat = (time: number, extra: Record<string, unknown> = {}) => ({
  time,
  project: 'p',
  language: 'TypeScript',
  editor: 'VS Code',
  os: 'macOS',
  machine: 'm',
  category: 'coding',
  ...extra,
});

describe('counting time', () => {
  const start = 1_800_000_000 - (1_800_000_000 % 86400); // a UTC midnight
  const end = start + 86400;

  it('credits gaps up to the timeout and ignores longer ones', () => {
    const b = [beat(start + 3600), beat(start + 3600 + 120), beat(start + 3600 + 240), beat(start + 3600 + 240 + 3600)];
    const sum = summarizeDay(b, start, end, 900);
    // 120 + 120 credited; the 1-hour gap is idle; the last heartbeat has no successor
    expect(sum.rows[0][6]).toBe(240);
  });

  it('stops the last session of the day at midnight', () => {
    const b = [beat(end - 60), beat(end + 60)];
    const sum = summarizeDay(b, start, end, 900);
    expect(sum.rows[0][6]).toBe(60);
  });

  it('splits time across the hours it covers', () => {
    const b = [beat(start + 3600 - 60), beat(start + 3600 + 60)];
    const sum = summarizeDay(b, start, end, 900);
    expect(Object.fromEntries(sum.hours)).toEqual({ 0: 60, 1: 60 });
  });

  it('keeps projects, languages and editors apart', () => {
    const b = [beat(start + 100), beat(start + 200, { language: 'Go' }), beat(start + 300)];
    const rows = summarizeDay(b, start, end, 900).rows;
    expect(rows.map((r) => [r[1], r[6]])).toEqual([
      ['TypeScript', 100],
      ['Go', 100],
    ]);
  });

  it('collects AI time, sessions, prompts, tokens and lines per model', () => {
    const ai = { category: 'ai coding', ai_model: 'Opus 4.1', ai_session: 's1', ai_input_tokens: 100, ai_output_tokens: 10, ai_line_changes: 5 };
    const b = [beat(start + 100, { ...ai, ai_prompt_length: 40 }), beat(start + 160, ai), beat(start + 220, { ai_line_changes: 3 }), beat(start + 280)];
    const [model] = summarizeDay(b, start, end, 900).ai.filter((a) => a[0] === 'Opus 4.1');
    // [model, seconds, sessions, prompts, in, out, cached, lines]
    expect(model).toEqual(['Opus 4.1', 120, 1, 1, 200, 20, 0, 10]);
  });

  it('does not count AI-edited lines in normal coding as AI time', () => {
    const b = [beat(start + 100, { ai_line_changes: 3 }), beat(start + 200)];
    const ai = summarizeDay(b, start, end, 900).ai;
    expect(ai).toEqual([['', 0, 0, 0, 0, 0, 0, 3]]);
  });
});

describe('time zones', () => {
  it('finds local midnight', () => {
    const t = dayStart('2026-11-11', 'Asia/Kolkata');
    expect(new Date(t * 1000).toISOString()).toBe('2026-11-10T18:30:00.000Z');
    expect(dayOf(t, 'Asia/Kolkata')).toBe('2026-11-11');
    expect(dayOf(t - 1, 'Asia/Kolkata')).toBe('2026-11-10');
  });

  it('handles daylight saving days', () => {
    const tz = 'America/New_York';
    expect(dayStart('2026-03-09', tz) - dayStart('2026-03-08', tz)).toBe(23 * 3600);
    expect(dayStart('2026-11-02', tz) - dayStart('2026-11-01', tz)).toBe(25 * 3600);
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('resolves named ranges', () => {
    const r = resolveRange('last_7_days', 'UTC', null)!;
    expect(addDays(r.start, 6)).toBe(r.end);
    expect(resolveRange('nope', 'UTC', null)).toBeNull();
    expect(resolveRange(undefined, 'UTC', null, '2026-01-01', '2026-01-31')!.name).toBe('custom');
  });

  it('formats durations like WakaTime', () => {
    expect(durationText(0)).toBe('0 secs');
    expect(durationText(61)).toBe('1 min');
    expect(durationText(3600)).toBe('1 hr');
    expect(durationText(2 * 3600 + 5 * 60)).toBe('2 hrs 5 mins');
  });
});

describe('user agents', () => {
  it('reads editor and OS', () => {
    expect(parseUserAgent('wakatime/v2.28.4 (darwin-24.1.0-arm64) go1.25.0 vscode/1.95.0 vscode-wakatime/25.0.0')).toEqual({
      editor: 'VS Code',
      os: 'macOS',
      model: '',
    });
    expect(parseUserAgent('wakatime/v2 (linux-6.8-x86_64) go1.25 cursor/1.2.3 vscode-wakatime/25.0.0').editor).toBe('Cursor');
    expect(parseUserAgent('wakatime/v2 (windows-10-x86_64) go1.25 PyCharm/2025.2 PyCharm-wakatime/15.0.0')).toMatchObject({ editor: 'PyCharm', os: 'Windows' });
  });

  it('reads the AI model the CLI puts first, without mistaking it for the editor', () => {
    expect(parseUserAgent('wakatime/v2 (darwin-24-arm64) go1.25 opus/4.1-medium claude/2.0.14 claude-code-wakatime/1.2.0')).toEqual({
      editor: 'Claude Code',
      os: 'macOS',
      model: 'Opus 4.1-medium',
    });
    expect(parseUserAgent('wakatime/v2 (linux-6-x86_64) go1.25 gpt/5.2 codex/0.40 codex-wakatime/1.0').model).toBe('GPT 5.2');
    // newer model tokens, odd versions and desktop-app names
    expect(parseUserAgent('wakatime/v2 (darwin-25-arm64) go1.25 opus/5-5 claude/2.1 claude-code-wakatime/3.1')).toMatchObject({ editor: 'Claude Code', model: 'Opus 5.5' });
    expect(parseUserAgent('wakatime/v2 (darwin-25-arm64) go1.25 opus/unknown claude/2.1 claude-code-wakatime/3.1')).toMatchObject({ editor: 'Claude Code', model: 'Opus' });
    expect(parseUserAgent('opus/4-1-medium claude/2.1 claude-code-wakatime/3.1')).toMatchObject({ editor: 'Claude Code', model: 'Opus 4.1-medium' });
    expect(parseUserAgent('wakatime/v2 (darwin-25-arm64) go1.25 GoogleChrome/141 macos-wakatime/5.0').editor).toBe('Chrome');
    // "claude/..." on its own is the Claude Code editor, not a model
    expect(parseUserAgent('wakatime/v2 (darwin-24-arm64) go1.25 claude/2.0.14 claude-code-wakatime/1.2.0')).toMatchObject({ editor: 'Claude Code', model: '' });
  });
});

describe('browser user agents', () => {
  it('reads browser extensions and web-view apps', () => {
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 chrome-wakatime/4.0.9';
    expect(parseUserAgent(chrome)).toEqual({ editor: 'Chrome', os: 'macOS', model: '' });
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0').editor).toBe('Firefox');
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36 Edg/131.0')).toEqual({ editor: 'Edge', os: 'Windows', model: '' });
    expect(parseUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.105 Chrome/130 Electron/33 Safari/537.36').editor).toBe('Slack');
    expect(parseUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15').editor).toBe('Safari');
  });
});
