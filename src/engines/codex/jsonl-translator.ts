import type { SDKMessage } from '../claude/executor.js';

export interface CodexTranslatorState {
  sessionId?: string;
  lastAgentText: string;
  startTime: number;
  model?: string;
  contextWindow?: number;
  lastUsage?: CodexUsage;
}

export interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  payload?: CodexPayload;
  error?: { message?: string };
  message?: string;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface CodexPayload {
  type?: string;
  info?: {
    last_token_usage?: CodexUsage;
    total_token_usage?: CodexUsage;
    model_context_window?: number;
  };
}

export type CodexItem =
  | { id: string; type: 'agent_message'; text?: string }
  | {
      id: string;
      type: 'command_execution';
      command?: string;
      aggregated_output?: string;
      exit_code?: number | null;
      status?: string;
    }
  | { id: string; type: string; [key: string]: unknown };

export function createCodexTranslatorState(options: {
  model?: string;
  contextWindow?: number;
} = {}): CodexTranslatorState {
  return {
    lastAgentText: '',
    startTime: Date.now(),
    model: options.model,
    contextWindow: options.contextWindow,
  };
}

export function translateCodexJsonEvent(
  event: CodexJsonEvent,
  state: CodexTranslatorState,
): SDKMessage[] {
  switch (event.type) {
    case 'thread.started':
      if (!event.thread_id) return [];
      state.sessionId = event.thread_id;
      return [{ type: 'system', subtype: 'init', session_id: event.thread_id }];

    case 'item.started':
      if (!event.item) return [];
      return translateStartedItem(event.item, state);

    case 'item.completed':
      if (!event.item) return [];
      return translateCompletedItem(event.item, state);

    case 'turn.completed':
      return [buildResultMessage(event.usage, state, false)];

    case 'turn.failed':
      return [buildResultMessage(undefined, state, true, event.error?.message)];

    case 'event_msg':
      updateTokenCount(event.payload, state);
      return [];

    case 'error':
      return event.message
        ? [{ type: 'task_notification', session_id: state.sessionId, result: event.message }]
        : [];

    default:
      return [];
  }
}

function translateStartedItem(item: CodexItem, state: CodexTranslatorState): SDKMessage[] {
  if (item.type !== 'command_execution') return [];
  return [{
    type: 'assistant',
    session_id: state.sessionId,
    message: {
      content: [{
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: typeof item.command === 'string' ? item.command : '' },
      }],
    },
  }];
}

function translateCompletedItem(item: CodexItem, state: CodexTranslatorState): SDKMessage[] {
  if (item.type === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : '';
    state.lastAgentText = text;
    return [{
      type: 'assistant',
      session_id: state.sessionId,
      message: { content: [{ type: 'text', text }] },
    }];
  }

  if (item.type === 'command_execution') {
    return [{
      type: 'user',
      session_id: state.sessionId,
      message: {
        content: [{
          type: 'tool_result',
          id: item.id,
          text: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
        }],
      },
    }];
  }

  return [];
}

function updateTokenCount(payload: CodexPayload | undefined, state: CodexTranslatorState): void {
  if (payload?.type !== 'token_count') return;
  const info = payload.info;
  if (!info) return;
  if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
    state.contextWindow = info.model_context_window;
  }
  if (info.last_token_usage) {
    state.lastUsage = info.last_token_usage;
  }
}

function estimateCodexApiEquivalentCostUsd(
  model: string | undefined,
  usage: CodexUsage | undefined,
): number | undefined {
  if (!model || !usage) return undefined;
  const normalizedModel = model.toLowerCase();
  const pricing = CODEX_API_PRICING[normalizedModel];
  if (!pricing) return undefined;

  const inputTokens = Math.max(0, usage.input_tokens ?? 0);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, usage.cached_input_tokens ?? 0));
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const outputTokens = Math.max(0, usage.output_tokens ?? 0);
  const usesLongContextPricing =
    pricing.longContextThreshold !== undefined && inputTokens > pricing.longContextThreshold;
  const inputMultiplier = usesLongContextPricing ? (pricing.longContextInputMultiplier ?? 1) : 1;
  const outputMultiplier = usesLongContextPricing ? (pricing.longContextOutputMultiplier ?? 1) : 1;

  return (
    (uncachedInputTokens * pricing.input * inputMultiplier +
      cachedInputTokens * pricing.cachedInput * inputMultiplier +
      outputTokens * pricing.output * outputMultiplier) /
    1_000_000
  );
}

interface CodexApiPricing {
  /** Standard USD price per one million tokens. */
  input: number;
  cachedInput: number;
  output: number;
  /** Long-context pricing applies only when input tokens exceed this threshold. */
  longContextThreshold?: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
}

const CODEX_API_PRICING: Readonly<Record<string, CodexApiPricing>> = {
  'gpt-5.6': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-6-astra': {
    input: 10,
    cachedInput: 1,
    output: 50,
    longContextThreshold: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
  },
};

function buildResultMessage(
  usage: CodexUsage | undefined,
  state: CodexTranslatorState,
  isError: boolean,
  errorMessage?: string,
): SDKMessage {
  const reliableUsage = state.lastUsage ?? usage;
  const outputTokens = reliableUsage?.output_tokens ?? 0;
  const totalTokens = reliableUsage?.total_tokens;
  const inputTokens = typeof totalTokens === 'number'
    ? Math.max(0, totalTokens - outputTokens)
    : reliableUsage?.input_tokens ?? 0;
  const contextWindow = state.contextWindow ?? 0;
  const reportedTokens = inputTokens + outputTokens;
  const estimatedCostUsd = estimateCodexApiEquivalentCostUsd(state.model, reliableUsage);
  // Codex turn.completed usage can be cumulative across the whole resumed
  // thread. If we did not see a token_count.last_token_usage event and the
  // reported total is larger than the model window, it is not a valid ctx
  // occupancy value. Keep model/duration visible but suppress the bogus ctx.
  const usageLooksCumulative = !state.lastUsage && contextWindow > 0 && reportedTokens > contextWindow;
  const modelUsage = state.model
    ? {
        [state.model]: {
          inputTokens: usageLooksCumulative ? 0 : inputTokens,
          outputTokens: usageLooksCumulative ? 0 : outputTokens,
          contextWindow: usageLooksCumulative ? 0 : contextWindow,
          costUSD: estimatedCostUsd ?? 0,
        },
      }
    : undefined;

  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    session_id: state.sessionId,
    duration_ms: Date.now() - state.startTime,
    total_cost_usd: estimatedCostUsd,
    result: state.lastAgentText,
    is_error: isError,
    errors: isError ? [errorMessage || 'Codex execution failed'] : undefined,
    modelUsage,
  };
}
