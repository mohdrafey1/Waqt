// What your AI token use would cost at API list prices (USD per million tokens).
// Subscriptions such as Claude Max or ChatGPT plans are flat-rate, so this is
// "what the same work would cost on the API", not your bill. Edit the table in
// the AI tab; the longest matching name wins ("Opus 5.5" before "Opus").

export type Price = [match: string, input: number, output: number, cached: number];

// List prices checked November 2026. Cached = cache reads.
export const DEFAULT_AI_PRICES: Price[] = [
  ['Fable', 10, 50, 1],
  ['Opus 5.5', 4, 20, 0.2],
  ['Opus', 5, 25, 0.5], // Opus 4.5 and later, Opus 5
  ['Opus 4', 15, 75, 1.5], // Opus 4 and 4.1
  ['Opus 4.5', 5, 25, 0.5],
  ['Opus 4.6', 5, 25, 0.5],
  ['Opus 4.7', 5, 25, 0.5],
  ['Sonnet 5.5', 2, 10, 0.1],
  ['Sonnet 5', 2, 10, 0.2],
  ['Sonnet', 3, 15, 0.3],
  ['Haiku 5.5', 0.1, 0.5, 0.01],
  ['Haiku', 1, 5, 0.1],
  ['GPT 6 Astra', 10, 50, 1],
  ['GPT', 2, 10, 0.1],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_/.]+/g, ' ')
    .replace(/^claude\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

export function priceFor(model: string, table: Price[]): Price | null {
  const m = norm(model);
  if (!m) return null;
  let best: Price | null = null;
  for (const p of table) {
    const k = norm(p[0]);
    if (k && (m === k || m.startsWith(k + ' ') || (k.length > 3 && m.startsWith(k)))) {
      if (!best || k.length > norm(best[0]).length) best = p;
    }
  }
  return best;
}

export function tokenCost(p: Price, input: number, output: number, cached: number): number {
  return (input * p[1] + output * p[2] + cached * p[3]) / 1_000_000;
}

export function parsePrices(json: string): Price[] {
  if (!json) return DEFAULT_AI_PRICES;
  try {
    const list = JSON.parse(json);
    if (!Array.isArray(list)) return DEFAULT_AI_PRICES;
    return cleanPrices(list) ?? DEFAULT_AI_PRICES;
  } catch {
    return DEFAULT_AI_PRICES;
  }
}

/** Validated price table, or null if the input isn't one. */
export function cleanPrices(list: unknown): Price[] | null {
  if (!Array.isArray(list) || list.length > 60) return null;
  const out: Price[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].trim()) return null;
    const nums = [row[1], row[2], row[3] ?? 0].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 10000)) return null;
    out.push([row[0].trim().slice(0, 60), nums[0], nums[1], nums[2]]);
  }
  return out;
}
