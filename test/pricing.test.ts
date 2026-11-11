import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_PRICES, priceFor, tokenCost } from '../src/pricing';
import { auth, beats, json, post, put } from './helpers';

describe('AI cost estimate', () => {
  it('picks the longest matching price', () => {
    expect(priceFor('Opus 5.5', DEFAULT_AI_PRICES)?.[0]).toBe('Opus 5.5');
    expect(priceFor('Opus 4.1-medium', DEFAULT_AI_PRICES)?.[0]).toBe('Opus 4');
    expect(priceFor('Opus 4.5', DEFAULT_AI_PRICES)?.[0]).toBe('Opus 4.5');
    expect(priceFor('Opus 5', DEFAULT_AI_PRICES)?.[0]).toBe('Opus');
    expect(priceFor('Sonnet 5.5', DEFAULT_AI_PRICES)?.[0]).toBe('Sonnet 5.5');
    expect(priceFor('Sonnet 5', DEFAULT_AI_PRICES)?.[0]).toBe('Sonnet 5');
    expect(priceFor('Sonnet 4.5', DEFAULT_AI_PRICES)?.[0]).toBe('Sonnet');
    expect(priceFor('claude-haiku-5-5', DEFAULT_AI_PRICES)?.[0]).toBe('Haiku 5.5');
    expect(priceFor('Gemini 3', DEFAULT_AI_PRICES)).toBeNull();
    expect(priceFor('', DEFAULT_AI_PRICES)).toBeNull();
    expect(tokenCost(['x', 4, 20, 0.2], 1_000_000, 500_000, 2_000_000)).toBeCloseTo(4 + 10 + 0.4);
  });

  it('adds a private estimate to stats, editable and optionally public', async () => {
    const ua = 'wakatime/v2 (darwin-25-arm64) go1.25 opus/5-5 claude/2.1 claude-code-wakatime/3.1';
    await post(
      '/api/v1/users/current/heartbeats.bulk',
      beats(3, { project: 'cost', endAgo: 64000, extra: { user_agent: ua, category: 'ai coding', ai_input_tokens: 1_000_000, ai_output_tokens: 100_000 } }),
    );
    let st = (await json('/api/v1/users/current/stats/last_7_days', { headers: auth })).body.data;
    const opus = st.ai.models.find((m: any) => m.name === 'Opus 5.5');
    expect(opus.cost).toBeCloseTo((3 * 4) + (0.3 * 20), 1);
    expect(st.ai.cost.total).toBeGreaterThanOrEqual(opus.cost);

    // Not public by default.
    expect((await json('/api/v1/users/me/stats/last_7_days')).body.data.ai.cost).toBeUndefined();

    const bad = await put('/api/v1/users/current/settings', { ai_prices: [['Opus', -1, 2, 3]] });
    expect(bad.status).toBe(400);
    await put('/api/v1/users/current/settings', { ai_prices: [['Opus', 1, 1, 0]], ai_cost_public: true });
    st = (await json('/api/v1/users/me/stats/last_7_days')).body.data;
    expect(st.ai.models.find((m: any) => m.name === 'Opus 5.5').cost).toBeCloseTo(3.3, 1);
    await put('/api/v1/users/current/settings', { ai_prices: null, ai_cost_public: false });
    const s = (await json('/api/v1/users/current/settings', { headers: auth })).body.data;
    expect(s.ai_prices_custom).toBe(false);
  });
});
