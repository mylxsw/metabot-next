import type { CardState, ToolCall } from '../types.js';

/**
 * Output mode for the bridge's per-turn card rendering.
 *
 * - 'monolog' (default) — the bridge keeps one Telegram message per turn and
 *   edits it in place as the agent streams. This is the historical behaviour
 *   that all platforms (Feishu, Slack, WeChat, web) still use.
 *
 * - 'steps'            — the bridge opens a NEW Telegram message for every
 *   semantically-complete step of the agent's turn (tool call → tool result,
 *   text block, final summary). Each step is a separate chat bubble in the
 *   user's history. Configured per-bot via `bots.json`:
 *   `{ "telegramBots": [{ ..., "outputMode": "steps" }] }`.
 */
export type OutputMode = 'monolog' | 'steps';

export type StepKind = 'tool-start' | 'text-block' | 'final' | 'error';

export interface StepBoundary {
  /**
   * 'monolog' — caller should keep using `updateCard(messageId, state)` against
   * the one-and-only message that the bridge opened for this turn. All other
   * fields in this object are unspecified.
   *
   * 'open' — caller should `sendCard(chatId, stepState)` to start a new chat
   * bubble and remember its `messageId` for any later updates of this step.
   *
   * 'update' — caller should `updateCard(lastOpenMessageId, stepState)` to
   * patch the previously-opened step bubble.
   *
   * 'noop' — nothing should be sent (the bridge has no current message yet
   * and no new content is ready).
   */
  action: 'monolog' | 'open' | 'update' | 'noop';
  /** What kind of step this boundary represents. Only meaningful for open/close. */
  kind?: StepKind;
  /** Footer payload for 'final' kind. */
  finalPayload?: Pick<CardState, 'costUsd' | 'durationMs' | 'model' | 'totalTokens' | 'contextWindow'>;
}

/**
 * Mutable per-turn tracking that the bridge feeds into {@link decideStepBoundary}.
 * The bridge owns one instance per active task and resets it when a new turn
 * begins.
 */
export interface StepsEmitterContext {
  outputMode: OutputMode;
  /** What kind of step was opened last (and may still be in-flight). */
  lastOpenStepKind: StepKind | null;
  /**
   * Length of `responseText` last time we opened the current text-block.
   * Used to detect "still streaming this same block" (text grew) vs
   * "new text starts after a tool" (text jumped from 0 / a settled value).
   */
  lastOpenTextLength: number;
}

/**
 * Pure decision function. Given the previous and current CardState snapshots
 * and the emitter's running context, returns what the bridge should do next.
 *
 * Kept as a free function so it can be unit-tested without spinning up a
 * MessageBridge.
 *
 * NOTE: The `complete` / `error` short-circuit branches below are technically
 * dead in production — the streaming loops break out on `state.status ===
 * 'complete' || state.status === 'error'` BEFORE calling `renderStreamingCard`,
 * so the final delivery always goes through `sendFinalCard` with the
 * StepsEmitter's lastOpenMessageId. We keep the logic here anyway because:
 *   1. The `decideStepBoundary` function is exported and tested independently,
 *      and the test cases document the intended semantics.
 *   2. If a future caller stops pre-breaking on terminal state, the contract
 *      already does the right thing — no extra wiring needed.
 */
export function decideStepBoundary(
  state: CardState,
  prev: CardState | undefined,
  ctx: StepsEmitterContext,
): StepBoundary {
  if (ctx.outputMode === 'monolog') {
    return { action: 'monolog' };
  }

  // Final short-circuit. If there's already an open step bubble, patch it
  // in place instead of opening a redundant one — otherwise a short-reply
  // turn (e.g. an agent that just says "yes, I'm here") would show two
  // identical bubbles: one Running…, one Complete. Falls back to opening
  // a fresh final bubble only when nothing is open yet (no streaming
  // activity at all, e.g. a SDK that returns only a 'result').
  if (state.status === 'complete') {
    const payload: StepBoundary['finalPayload'] = {
      costUsd: state.costUsd,
      durationMs: state.durationMs,
      model: state.model,
      totalTokens: state.totalTokens,
      contextWindow: state.contextWindow,
    };
    if (ctx.lastOpenStepKind === 'text-block' || ctx.lastOpenStepKind === 'tool-start') {
      return {
        action: 'update',
        kind: ctx.lastOpenStepKind,
        finalPayload: payload,
      };
    }
    return {
      action: 'open',
      kind: 'final',
      finalPayload: payload,
    };
  }
  if (state.status === 'error') {
    // Same anti-duplicate-bubble logic — if a step is in flight, mark it
    // error in place instead of stacking another bubble.
    if (ctx.lastOpenStepKind === 'text-block' || ctx.lastOpenStepKind === 'tool-start') {
      return {
        action: 'update',
        kind: ctx.lastOpenStepKind,
      };
    }
    return {
      action: 'open',
      kind: 'error',
    };
  }

  const prevToolCount = prev?.toolCalls.length ?? 0;
  const currToolCount = state.toolCalls.length;
  const prevTextLength = prev?.responseText.length ?? 0;
  const currTextLength = state.responseText.length;

  // Tool-count growth means a brand-new tool fired. The exception: the
  // emitter already has a tool-start bubble open and the previous snapshot
  // is unknown (caller omitted prev). In that case the new tool with
  // current count is the SAME tool finishing / gaining detail, so don't
  // open another bubble — fall through to the text-block branches below.
  const sameToolAsInFlight = prev === undefined && ctx.lastOpenStepKind === 'tool-start';

  if (currToolCount > prevToolCount && !sameToolAsInFlight) {
    return { action: 'open', kind: 'tool-start' };
  }

  // Tool present, count stable, and the tools themselves changed in some
  // observable way (a running→done flip, or a late detail update). Patch
  // the in-flight tool-start bubble in place. If the tool set is identical
  // to the previous snapshot (same names, statuses, details) AND the tool
  // is already 'done', fall through — nothing to update; the next call is
  // likely going to bring text.
  if (currToolCount > 0 && currToolCount === prevToolCount && prev !== undefined) {
    const changed = hasToolStateChanged(prev.toolCalls, state.toolCalls);
    if (changed) {
      return { action: 'update', kind: 'tool-start' };
    }
  }

  // No tool calls — text-block territory.
  if (currTextLength === 0) {
    return { action: 'noop' };
  }

  // First text we see this turn → open text-block.
  if (prev === undefined || prevTextLength === 0) {
    return { action: 'open', kind: 'text-block' };
  }

  // Continuing the same text-block (text grew within an already-open block).
  if (ctx.lastOpenStepKind === 'text-block' && currTextLength > ctx.lastOpenTextLength) {
    return { action: 'update', kind: 'text-block' };
  }

  // Text resumed after a tool finished — open a new text-block.
  if (currTextLength > prevTextLength) {
    return { action: 'open', kind: 'text-block' };
  }

  return { action: 'noop' };
}

function hasToolStateChanged(prev: ToolCall[], curr: ToolCall[]): boolean {
  if (prev.length !== curr.length) return true;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = curr[i];
    if (a.name !== b.name) return true;
    if (a.status !== b.status) return true;
    if (a.detail !== b.detail) return true;
  }
  return false;
}

/**
 * Stateful wrapper around {@link decideStepBoundary} that maintains the
 * per-turn context for the bridge. One instance per active task; call
 * `reset()` at the start of every new turn.
 */
export class StepsEmitter {
  private ctx: StepsEmitterContext;
  // In monolog mode we don't need the previous snapshot — every observe()
  // returns the same { action: 'monolog' } and the state is only read again
  // by `decideStepBoundary` when outputMode flips to 'steps'. Skip storing
  // it to avoid retaining the full CardState (potentially with a long
  // responseText and many tool calls) for the lifetime of the RunningTask.
  private lastObservedState: CardState | null = null;
  private lastOpenMessageId: string | null = null;

  constructor(init: { outputMode: OutputMode }) {
    this.ctx = {
      outputMode: init.outputMode,
      lastOpenStepKind: null,
      lastOpenTextLength: 0,
    };
  }

  /**
   * Observe a new snapshot. Returns the boundary decision. The emitter
   * remembers the previous observation internally so callers don't need
   * to thread the prev snapshot through. Callers should also call
   * {@link recordDispatch} so the emitter's context stays in sync with
   * what was actually sent.
   */
  observe(state: CardState): StepBoundary {
    const boundary = decideStepBoundary(state, this.lastObservedState ?? undefined, this.ctx);
    // Update internal context for the next observe() call.
    if (boundary.action === 'open') {
      this.ctx.lastOpenStepKind = boundary.kind ?? null;
      if (boundary.kind === 'text-block' || boundary.kind === 'tool-start') {
        this.ctx.lastOpenTextLength = state.responseText.length;
      } else {
        // final / error — turn is over, no further updates expected.
        this.ctx.lastOpenStepKind = null;
        this.ctx.lastOpenTextLength = 0;
      }
    } else if (boundary.action === 'update' && boundary.kind === 'text-block') {
      this.ctx.lastOpenTextLength = state.responseText.length;
    }
    // Only retain the snapshot when it'll actually be read next time —
    // monolog mode short-circuits in decideStepBoundary without consulting
    // prev.
    if (this.ctx.outputMode === 'steps') {
      this.lastObservedState = state;
    }
    return boundary;
  }

  /** Call after the bridge successfully `sendCard`ed a new message for a step. */
  recordDispatch(messageId: string): void {
    this.lastOpenMessageId = messageId;
  }

  /** The messageId the bridge last opened for the current step, if any. */
  getCurrentMessageId(): string | null {
    return this.lastOpenMessageId;
  }

  /** Reset all per-turn state. Call when a new turn starts. */
  reset(): void {
    this.ctx.lastOpenStepKind = null;
    this.ctx.lastOpenTextLength = 0;
    this.lastOpenMessageId = null;
    this.lastObservedState = null;
  }
}