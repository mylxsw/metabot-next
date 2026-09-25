import { describe, expect, it } from 'vitest';
import { estimateClaudeApiEquivalentCostUsd } from '../src/engines/claude/pricing.js';

describe('Claude API-equivalent pricing', () => {
  it.each([
    ['claude-opus-5-5', 0.101],
    ['claude-fable-5-1', 0.2325],
    ['claude-sonnet-5', 0.0585],
  ])('estimates %s with input, cache read, cache write, and output tokens', (model, expected) => {
    expect(estimateClaudeApiEquivalentCostUsd(model, {
      inputTokens: 10_000,
      cacheReadInputTokens: 80_000,
      cacheCreationInputTokens: 5_000,
      outputTokens: 1_000,
    })).toBeCloseTo(expected, 8);
  });

  it('accepts gateway model names without the claude prefix', () => {
    expect(estimateClaudeApiEquivalentCostUsd('opus-5-5', {
      inputTokens: 1_000_000,
    })).toBe(4);
  });

  it('does not guess pricing for an unknown routed model', () => {
    expect(estimateClaudeApiEquivalentCostUsd('coding/auto', {
      inputTokens: 1_000_000,
    })).toBeUndefined();
  });
});
