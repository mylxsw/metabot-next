import { describe, expect, it } from 'vitest';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import {
  createCodexTranslatorState,
  translateCodexJsonEvent,
  type CodexJsonEvent,
} from '../src/engines/codex/jsonl-translator.js';

describe('Codex JSONL translator', () => {
  it('maps Codex exec events into the existing stream processor shape', () => {
    const events: CodexJsonEvent[] = [
      { type: 'thread.started', thread_id: '019dbe98-98b1-78b1-a6b0-b422e495db52' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'I’ll run `pwd` once.' },
      },
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: '/bin/zsh -lc pwd',
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: '/bin/zsh -lc pwd',
          aggregated_output: '/Users/maxzhou/Dev/metabot\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'DONE' } },
      { type: 'turn.completed', usage: { input_tokens: 23111, cached_input_tokens: 12800, output_tokens: 70 } },
    ];

    const state = createCodexTranslatorState({ model: 'gpt-5.5', contextWindow: 400000 });
    const processor = new StreamProcessor('Run pwd');

    let cardState = processor.processMessage({ type: 'system' });
    for (const event of events) {
      for (const message of translateCodexJsonEvent(event, state)) {
        cardState = processor.processMessage(message);
      }
    }

    expect(processor.getSessionId()).toBe('019dbe98-98b1-78b1-a6b0-b422e495db52');
    expect(cardState.status).toBe('complete');
    expect(cardState.responseText).toBe('DONE');
    expect(cardState.toolCalls).toEqual([{ name: 'Bash', detail: '`/bin/zsh -lc pwd`', status: 'done' }]);
    expect(cardState.model).toBe('gpt-5.5');
    expect(cardState.totalTokens).toBe(23181);
    expect(cardState.contextWindow).toBe(400000);
  });

  it('estimates API-equivalent cost for gpt-5.6-sol with cached input pricing', () => {
    const state = createCodexTranslatorState({ model: 'gpt-5.6-sol', contextWindow: 258_400 });
    const processor = new StreamProcessor('estimate this turn');
    let cardState = processor.processMessage({ type: 'system' });

    for (const message of translateCodexJsonEvent(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100_000,
          cached_input_tokens: 80_000,
          output_tokens: 10_000,
          total_tokens: 110_000,
        },
      },
      state,
    )) {
      cardState = processor.processMessage(message);
    }

    // 20k uncached input × $5/M + 80k cached × $0.50/M + 10k output × $30/M.
    expect(cardState.costUsd).toBeCloseTo(0.44, 8);
  });

  it('estimates API-equivalent cost for gpt-6-astra with cached input pricing', () => {
    const state = createCodexTranslatorState({ model: 'gpt-6-astra', contextWindow: 1_050_000 });
    const processor = new StreamProcessor('estimate this Astra turn');
    let cardState = processor.processMessage({ type: 'system' });

    for (const message of translateCodexJsonEvent(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100_000,
          cached_input_tokens: 80_000,
          output_tokens: 10_000,
          total_tokens: 110_000,
        },
      },
      state,
    )) {
      cardState = processor.processMessage(message);
    }

    // 20k uncached input × $10/M + 80k cached × $1/M + 10k output × $50/M.
    expect(cardState.costUsd).toBeCloseTo(0.78, 8);
  });

  it('uses gpt-6-astra long-context pricing only above 272k input tokens', () => {
    const atThreshold = createCodexTranslatorState({ model: 'gpt-6-astra', contextWindow: 1_050_000 });
    const atThresholdResult = translateCodexJsonEvent(
      {
        type: 'turn.completed',
        usage: { input_tokens: 272_000, output_tokens: 1_000, total_tokens: 273_000 },
      },
      atThreshold,
    )[0];
    expect(atThresholdResult.total_cost_usd).toBeCloseTo(2.77, 8);

    const aboveThreshold = createCodexTranslatorState({ model: 'gpt-6-astra', contextWindow: 1_050_000 });
    const aboveThresholdResult = translateCodexJsonEvent(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 300_000,
          cached_input_tokens: 100_000,
          output_tokens: 20_000,
          total_tokens: 320_000,
        },
      },
      aboveThreshold,
    )[0];

    // Above 272k: input/cache × 2 and output × 1.5 for the full request.
    expect(aboveThresholdResult.total_cost_usd).toBeCloseTo(5.7, 8);
  });

  it('uses Codex token_count last_token_usage for ctx instead of cumulative totals', () => {
    const events: CodexJsonEvent[] = [
      { type: 'thread.started', thread_id: 'codex-thread' },
      { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'done' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 25_444_800,
              cached_input_tokens: 25_000_000,
              output_tokens: 300,
              total_tokens: 25_445_100,
            },
            last_token_usage: {
              input_tokens: 83_767,
              cached_input_tokens: 75_648,
              output_tokens: 314,
              total_tokens: 84_081,
            },
            model_context_window: 258_400,
          },
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 25_444_800,
          cached_input_tokens: 25_000_000,
          output_tokens: 300,
          total_tokens: 25_445_100,
        },
      },
    ];

    const state = createCodexTranslatorState({ model: 'gpt-5.5', contextWindow: 272_000 });
    const processor = new StreamProcessor('test ctx');
    let cardState = processor.processMessage({ type: 'system' });
    for (const event of events) {
      for (const message of translateCodexJsonEvent(event, state)) {
        cardState = processor.processMessage(message);
      }
    }

    expect(cardState.status).toBe('complete');
    expect(cardState.totalTokens).toBe(84_081);
    expect(cardState.contextWindow).toBe(258_400);
  });

  it('suppresses Codex ctx when only cumulative turn usage is available', () => {
    const state = createCodexTranslatorState({ model: 'gpt-5.5', contextWindow: 272_000 });
    const processor = new StreamProcessor('hello');
    let cardState = processor.processMessage({ type: 'system' });

    for (const message of translateCodexJsonEvent(
      { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'hi' } },
      state,
    )) {
      cardState = processor.processMessage(message);
    }
    for (const message of translateCodexJsonEvent(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 2_205_693,
          cached_input_tokens: 2_077_056,
          output_tokens: 55,
          total_tokens: 2_205_748,
        },
      },
      state,
    )) {
      cardState = processor.processMessage(message);
    }

    expect(cardState.status).toBe('complete');
    expect(cardState.model).toBe('gpt-5.5');
    expect(cardState.totalTokens).toBe(0);
    expect(cardState.contextWindow).toBe(0);
  });

  it('maps failed turns to error results', () => {
    const state = createCodexTranslatorState();
    const processor = new StreamProcessor('hello');

    for (const message of translateCodexJsonEvent({ type: 'thread.started', thread_id: 'codex-thread' }, state)) {
      processor.processMessage(message);
    }
    let cardState = processor.processMessage({ type: 'system' });
    for (const message of translateCodexJsonEvent({ type: 'turn.failed', error: { message: 'network failed' } }, state)) {
      cardState = processor.processMessage(message);
    }

    expect(cardState.status).toBe('error');
    expect(cardState.errorMessage).toBe('network failed');
  });

  it('captures session id from thread.started and leaves state empty otherwise', () => {
    const state = createCodexTranslatorState();
    expect(state.sessionId).toBeUndefined();

    const messages = translateCodexJsonEvent({ type: 'thread.started', thread_id: 'sid-1' }, state);
    expect(state.sessionId).toBe('sid-1');
    expect(messages).toEqual([{ type: 'system', subtype: 'init', session_id: 'sid-1' }]);
  });

  it('ignores thread.started without a thread_id (defensive)', () => {
    const state = createCodexTranslatorState();
    const messages = translateCodexJsonEvent({ type: 'thread.started' } as CodexJsonEvent, state);
    expect(messages).toEqual([]);
    expect(state.sessionId).toBeUndefined();
  });

  it('returns [] for unknown / unhandled event types', () => {
    const state = createCodexTranslatorState();
    expect(translateCodexJsonEvent({ type: 'turn.started' }, state)).toEqual([]);
    expect(translateCodexJsonEvent({ type: 'something.new' } as CodexJsonEvent, state)).toEqual([]);
  });

  it('emits a task_notification message for top-level Codex error events with a message', () => {
    const state = createCodexTranslatorState();
    state.sessionId = 'sid-err';
    const messages = translateCodexJsonEvent({ type: 'error', message: 'ratelimited' }, state);
    expect(messages).toEqual([
      { type: 'task_notification', session_id: 'sid-err', result: 'ratelimited' },
    ]);
  });

  it('drops error events that carry no message', () => {
    const state = createCodexTranslatorState();
    expect(translateCodexJsonEvent({ type: 'error' }, state)).toEqual([]);
  });

  it('tolerates item.completed agent_message with missing text', () => {
    const state = createCodexTranslatorState();
    const messages = translateCodexJsonEvent(
      { type: 'item.completed', item: { id: 'x', type: 'agent_message' } } as CodexJsonEvent,
      state,
    );
    expect(state.lastAgentText).toBe('');
    expect(messages[0]).toMatchObject({ type: 'assistant' });
  });

  it('falls back to a generic failure message when turn.failed has no error detail', () => {
    const state = createCodexTranslatorState();
    const [msg] = translateCodexJsonEvent({ type: 'turn.failed' }, state);
    expect(msg).toMatchObject({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['Codex execution failed'],
    });
  });
});
