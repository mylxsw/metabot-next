export interface ClaudeUsageForPricing {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ClaudeApiPricing {
  /** Standard USD price per one million tokens. */
  input: number;
  cacheRead: number;
  /** Claude Code uses the standard five-minute cache write unless configured otherwise. */
  cacheWrite: number;
  output: number;
}

const CLAUDE_API_PRICING: Readonly<Record<string, ClaudeApiPricing>> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-fable-5-1': { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
};

function normalizeClaudeModel(model: string): string {
  const normalized = model.toLowerCase().replace(/\[1m\]$/, '');
  return normalized.startsWith('claude-') ? normalized : `claude-${normalized}`;
}

export function estimateClaudeApiEquivalentCostUsd(
  model: string,
  usage: ClaudeUsageForPricing,
): number | undefined {
  const pricing = CLAUDE_API_PRICING[normalizeClaudeModel(model)];
  if (!pricing) return undefined;

  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const cacheReadTokens = Math.max(0, usage.cacheReadInputTokens ?? 0);
  const cacheWriteTokens = Math.max(0, usage.cacheCreationInputTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);

  return (
    inputTokens * pricing.input
    + cacheReadTokens * pricing.cacheRead
    + cacheWriteTokens * pricing.cacheWrite
    + outputTokens * pricing.output
  ) / 1_000_000;
}
