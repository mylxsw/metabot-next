import { describe, expect, it } from 'vitest';
import { renderCardHtml } from '../src/telegram/telegram-sender.js';
import type { CardState } from '../src/types.js';

describe('Telegram card footer', () => {
  it('shows API-equivalent turn and session cost estimates on completion', () => {
    const state: CardState = {
      status: 'complete',
      userPrompt: 'task',
      responseText: 'done',
      toolCalls: [],
      costUsd: 0.01234,
      sessionCostUsd: 0.05678,
      model: 'gpt-5.6-sol',
      durationMs: 5000,
    };

    const html = renderCardHtml(state);

    expect(html).toContain('API est: $0.0123');
    expect(html).toContain('session est: $0.0568');
  });
});
