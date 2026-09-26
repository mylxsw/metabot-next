import { describe, it, expect } from 'vitest';
import { StepsEmitter, decideStepBoundary, type OutputMode } from '../src/bridge/steps-emitter.js';
import type { CardState, ToolCall } from '../src/types.js';

function runningTool(name: string, detail = '`/tmp/x.ts`', status: 'running' | 'done' = 'running'): ToolCall {
  return { name, detail, status };
}

describe('decideStepBoundary — pure function', () => {
  it('returns monolog when outputMode is monolog', () => {
    const state: CardState = {
      status: 'running',
      userPrompt: 'fix bug',
      responseText: 'Looking at it...',
      toolCalls: [runningTool('Read')],
    };
    const out = decideStepBoundary(state, undefined, {
      outputMode: 'monolog',
      lastOpenStepKind: null,
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('monolog');
  });

  it('opens a tool-start message when a new tool appears and no tool was open', () => {
    const state: CardState = {
      status: 'running',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`')],
    };
    const out = decideStepBoundary(state, undefined, {
      outputMode: 'steps',
      lastOpenStepKind: null,
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('open');
    expect(out.kind).toBe('tool-start');
  });

  it('updates the same tool-start when status flips from running to done', () => {
    const state1: CardState = {
      status: 'running',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`')],
    };
    const state2: CardState = {
      ...state1,
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    };
    const out = decideStepBoundary(state2, state1, {
      outputMode: 'steps',
      lastOpenStepKind: 'tool-start',
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('update');
    expect(out.kind).toBe('tool-start');
  });

  it('opens a text-block after a tool completes and text appears', () => {
    const prev: CardState = {
      status: 'running',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    };
    const stateAfterTool: CardState = {
      ...prev,
      responseText: 'Now I will edit the file.',
    };
    const out = decideStepBoundary(stateAfterTool, prev, {
      outputMode: 'steps',
      lastOpenStepKind: 'tool-start',
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('open');
    expect(out.kind).toBe('text-block');
  });

  it('updates the same text-block message while text deltas arrive', () => {
    const prev: CardState = {
      status: 'running',
      userPrompt: 'fix bug',
      responseText: 'Hello',
      toolCalls: [],
    };
    const state: CardState = {
      ...prev,
      responseText: 'Hello world',
    };
    const out = decideStepBoundary(state, prev, {
      outputMode: 'steps',
      lastOpenStepKind: 'text-block',
      lastOpenTextLength: 5,
    });
    expect(out.action).toBe('update');
    expect(out.kind).toBe('text-block');
  });

  it('opens a final step message when nothing was open before completion', () => {
    const final: CardState = {
      status: 'complete',
      userPrompt: 'fix bug',
      responseText: 'Done.',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
      costUsd: 0.01,
      durationMs: 1234,
      model: 'claude-opus-5-5',
    };
    const out = decideStepBoundary(final, undefined, {
      outputMode: 'steps',
      lastOpenStepKind: null,
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('open');
    expect(out.kind).toBe('final');
    expect(out.finalPayload?.costUsd).toBe(0.01);
  });

  it('opens an error step when status is error', () => {
    const err: CardState = {
      status: 'error',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [],
      errorMessage: 'boom',
    };
    const out = decideStepBoundary(err, undefined, {
      outputMode: 'steps',
      lastOpenStepKind: null,
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('open');
    expect(out.kind).toBe('error');
  });

  it('updates the open text-block instead of opening a final bubble when the turn ends', () => {
    // Short-reply turn: text-block is already open, the very next snapshot
    // is 'complete'. Opening another bubble for "complete" would make the
    // user see two chat bubbles with identical content (one Running…, one
    // Complete). We patch the existing text-block in place to mark it
    // complete — same semantics as monolog mode.
    const final: CardState = {
      status: 'complete',
      userPrompt: 'are you still there',
      responseText: 'Yes, I am here.',
      toolCalls: [],
      costUsd: 0.0001,
      durationMs: 800,
      model: 'claude-opus-5-5',
    };
    const out = decideStepBoundary(final, undefined, {
      outputMode: 'steps',
      lastOpenStepKind: 'text-block',
      lastOpenTextLength: 14,
    });
    expect(out.action).toBe('update');
    expect(out.kind).toBe('text-block');
    expect(out.finalPayload?.costUsd).toBe(0.0001);
  });

  it('updates the open tool-start instead of opening a final bubble when the turn ends', () => {
    // Turn where the only output was a single tool call (no assistant text
    // afterwards) — completing the turn should still mark the existing
    // tool-start bubble complete, not spawn a second bubble.
    const final: CardState = {
      status: 'complete',
      userPrompt: 'run ls',
      responseText: '',
      toolCalls: [runningTool('Bash', '`ls`', 'done')],
      costUsd: 0.0002,
      durationMs: 600,
    };
    const out = decideStepBoundary(final, undefined, {
      outputMode: 'steps',
      lastOpenStepKind: 'tool-start',
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('update');
    expect(out.kind).toBe('tool-start');
    expect(out.finalPayload?.costUsd).toBe(0.0002);
  });

  it('still opens a fresh final bubble when nothing was open before completion', () => {
    // Edge case: terminal state arrives without any prior step bubbles
    // (e.g. SDK returned only a 'result' with no streaming activity).
    // Open a final so the user still sees a footer.
    const final: CardState = {
      status: 'complete',
      userPrompt: 'noop',
      responseText: '',
      toolCalls: [],
      costUsd: 0.0,
      durationMs: 100,
    };
    const out = decideStepBoundary(final, undefined, {
      outputMode: 'steps',
      lastOpenStepKind: null,
      lastOpenTextLength: 0,
    });
    expect(out.action).toBe('open');
    expect(out.kind).toBe('final');
  });
});

describe('StepsEmitter state tracking', () => {
  it('emits tool-start then update then text-block then final across a turn', () => {
    const emitter = new StepsEmitter({ outputMode: 'steps' });

    // First tool appears
    const a = emitter.observe({
      status: 'running',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`')],
    });
    expect(a.action).toBe('open');
    expect(a.kind).toBe('tool-start');

    // Tool completes (status flips) — same tool, same length → update
    const b = emitter.observe({
      status: 'running',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    });
    expect(b.action).toBe('update');
    expect(b.kind).toBe('tool-start');

    // Text now appears after the tool — open a fresh text-block
    const c = emitter.observe({
      status: 'running',
      userPrompt: 'fix bug',
      responseText: 'Will edit now.',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    });
    expect(c.action).toBe('open');
    expect(c.kind).toBe('text-block');

    // Text grows — update same block
    const d = emitter.observe({
      status: 'running',
      userPrompt: 'fix bug',
      responseText: 'Will edit now. Also fixing tests.',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    });
    expect(d.action).toBe('update');
    expect(d.kind).toBe('text-block');

    // Turn completes — patches the open text-block to mark complete, instead
    // of opening a redundant final bubble (which would duplicate the text).
    const e = emitter.observe({
      status: 'complete',
      userPrompt: 'fix bug',
      responseText: 'Will edit now. Also fixing tests.',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
      costUsd: 0.02,
      durationMs: 2000,
    });
    expect(e.action).toBe('update');
    expect(e.kind).toBe('text-block');
    expect(e.finalPayload?.costUsd).toBe(0.02);
  });

  it('opens an initial text-block when the first observation is text only', () => {
    const emitter = new StepsEmitter({ outputMode: 'steps' });
    const a = emitter.observe({
      status: 'running',
      userPrompt: 'greet',
      responseText: 'Hello there!',
      toolCalls: [],
    });
    expect(a.action).toBe('open');
    expect(a.kind).toBe('text-block');
  });

  it('monolog mode never opens multiple messages', () => {
    const emitter = new StepsEmitter({ outputMode: 'monolog' });
    const a = emitter.observe({
      status: 'running',
      userPrompt: 'fix bug',
      responseText: '',
      toolCalls: [runningTool('Read')],
    });
    expect(a.action).toBe('monolog');
    const b = emitter.observe({
      status: 'running',
      userPrompt: 'fix bug',
      responseText: 'Thinking',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    });
    expect(b.action).toBe('monolog');
    const c = emitter.observe({
      status: 'complete',
      userPrompt: 'fix bug',
      responseText: 'Done',
      toolCalls: [runningTool('Read', '`/tmp/x.ts`', 'done')],
    });
    expect(c.action).toBe('monolog');
  });

  it('reset() clears all per-turn state', () => {
    const emitter = new StepsEmitter({ outputMode: 'steps' });
    emitter.observe({
      status: 'running',
      userPrompt: 'a',
      responseText: '',
      toolCalls: [runningTool('Read')],
    });
    emitter.reset();
    // After reset, the next observation starts fresh — text-only opens a text-block.
    const a = emitter.observe({
      status: 'running',
      userPrompt: 'b',
      responseText: 'Hello again',
      toolCalls: [],
    });
    expect(a.action).toBe('open');
    expect(a.kind).toBe('text-block');
  });

  it('handles two consecutive turns without reset() crossing state', () => {
    const emitter = new StepsEmitter({ outputMode: 'steps' });

    // Turn 1 ends.
    emitter.observe({
      status: 'complete',
      userPrompt: 'first',
      responseText: 'done',
      toolCalls: [],
      costUsd: 0.001,
    });

    // New turn begins — caller must reset, otherwise the next observation
    // would inherit the previous turn's "complete" final state. Document
    // that contract with this assertion: without reset, the next state
    // would be misinterpreted; with reset, a fresh text-block opens.
    emitter.reset();
    const next = emitter.observe({
      status: 'running',
      userPrompt: 'second',
      responseText: 'new turn',
      toolCalls: [],
    });
    expect(next.action).toBe('open');
    expect(next.kind).toBe('text-block');
  });
});