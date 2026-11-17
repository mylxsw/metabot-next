import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCoreChatCapabilities,
  handleCoreChatRoutes,
  postCoreChatRunEvent,
  __resetCoreChatRunsForTests,
} from '../src/api/routes/core-chat-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import type { CardState } from '../src/types.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as any;

function makeReq(body: unknown): any {
  const req = new EventEmitter() as any;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function makeCtx(bridge: any): RouteContext {
  const botInfo = {
    name: 'metabot',
    platform: 'web',
    engine: 'codex',
    model: 'doubao-seed-1-6-flash',
    workingDirectory: '/tmp/metabot',
    ttsVoice: 'zh_female_sajiaonvyou_moon_bigtts',
  };
  return {
    registry: {
      get: (name: string) => name === 'metabot' ? { bridge } : undefined,
      list: () => [botInfo],
    } as any,
    scheduler: {} as any,
    logger,
    peerManager: undefined,
    asyncTaskStore: {} as any,
    intentRouter: {} as any,
    circuitBreaker: {
      isAvailable: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as any,
    budgetManager: {
      canAcceptTask: vi.fn(() => ({ allowed: true })),
      recordCost: vi.fn(),
    } as any,
    teamManager: {} as any,
    meetingService: {} as any,
    voiceIdentityStore: {} as any,
    rtcService: { isConfigured: () => true } as any,
    ws: {},
  };
}

function runBody(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    triggerMessageId: 'msg-1',
    targetBot: 'metabot',
    prompt: 'hello',
    eventCallbackUrl: 'https://core.example/api/chat/runs/run-1/events',
    ...overrides,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('handleCoreChatRoutes', () => {
  beforeEach(() => {
    __resetCoreChatRunsForTests();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    __resetCoreChatRunsForTests();
  });

  it('accepts a core-chat run and executes the bot with sendCards false', async () => {
    const executeApiTask = vi.fn(async ({ onUpdate, onOutputFiles }: any) => {
      const state: CardState = { status: 'running', userPrompt: 'hello', responseText: 'partial', toolCalls: [] };
      onUpdate(state, 'bridge-msg-1', false);
      onOutputFiles([{ filePath: '/tmp/out.txt', fileName: 'out.txt', extension: '.txt', isImage: false, sizeBytes: 12 }]);
      onUpdate({ ...state, status: 'complete', responseText: 'done' }, 'bridge-msg-1', true);
      return { success: true, responseText: 'done', costUsd: 0.01, durationMs: 5 };
    });
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const res = makeRes();

    const handled = await handleCoreChatRoutes(
      makeCtx(bridge),
      makeReq(runBody({ engine: 'codex', model: 'gpt-5.5-codex' })),
      res,
      'POST',
      '/api/core-chat/runs',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      runId: 'run-1',
      status: 'accepted',
      targetBot: 'metabot',
      executionChatId: 'core-conv-1-metabot',
    });
    await eventually(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'hello',
        chatId: 'core-conv-1-metabot',
        userId: 'core-chat',
        sendCards: false,
        engine: 'codex',
        model: 'gpt-5.5-codex',
      }));
      expect(fetch).toHaveBeenCalledTimes(4);
    });
    const events = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(events.map((event) => [event.seq, event.type])).toEqual([[1, 'state'], [2, 'state'], [3, 'file'], [4, 'complete']]);
    expect(events[0].payload.state).toMatchObject({ status: 'running', userPrompt: 'hello' });
    expect(events[2].payload.files[0].transfer).toMatchObject({ mode: 'bridge-private' });
    expect(events[2].payload.files[0].transfer.path).toBeUndefined();
    expect(events[3].payload.content).toBe('done');
    expect(events[3].payload.result).toMatchObject({ success: true, responseText: 'done' });
  });

  it('reports bridge voice and Doubao capabilities', async () => {
    vi.stubEnv('VOLCENGINE_TTS_APPID', 'appid');
    vi.stubEnv('VOLCENGINE_TTS_ACCESS_KEY', 'access-key');
    const ctx = makeCtx({ executeApiTask: vi.fn(), stopChatTask: vi.fn() });
    const res = makeRes();

    const handled = await handleCoreChatRoutes(ctx, makeReq({}), res, 'GET', '/api/core-chat/capabilities');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      auth: { mode: 'bridge-api-secret' },
      voice: {
        stt: { endpoint: '/api/voice?sttOnly=true', defaultProvider: 'doubao' },
        tts: { endpoint: '/api/tts', defaultProvider: 'doubao' },
        rtc: { configured: true },
      },
      routes: { coreChatRun: '/api/core-chat/runs' },
    });
    expect(res.json().agents[0]).toMatchObject({
      name: 'metabot',
      capabilities: { doubaoVoice: true, doubaoModel: true },
    });
  });

  it('can emit voice capability and TTS-ready log events around a run', async () => {
    vi.stubEnv('VOLCENGINE_TTS_APPID', 'appid');
    vi.stubEnv('VOLCENGINE_TTS_ACCESS_KEY', 'access-key');
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: '你好，我可以用语音回复。',
      costUsd: 0.01,
      durationMs: 5,
    }));
    const res = makeRes();

    await handleCoreChatRoutes(
      makeCtx({ executeApiTask, stopChatTask: vi.fn() }),
      makeReq(runBody({ voice: { announceCapabilities: true, tts: true } })),
      res,
      'POST',
      '/api/core-chat/runs',
    );

    await eventually(() => {
      expect(fetch).toHaveBeenCalledTimes(4);
    });
    const events = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(events.map((event) => event.type)).toEqual(['state', 'log', 'log', 'complete']);
    expect(events[0].payload.state).toMatchObject({ status: 'running', userPrompt: 'hello' });
    expect(events[1].payload).toMatchObject({
      kind: 'voice_capabilities',
      capabilities: { auth: { mode: 'bridge-api-secret' } },
    });
    expect(events[2].payload).toMatchObject({
      kind: 'voice_tts_ready',
      tts: {
        requested: true,
        endpoint: '/api/tts',
        provider: 'doubao',
      },
    });
  });

  it('reports questions and resumes the run with a Core Console answer', async () => {
    const executeApiTask = vi.fn(async ({ onQuestion }: any) => {
      const answer = await onQuestion({ toolUseId: 'tool-1', questions: [] });
      return { success: true, responseText: answer };
    });
    const res = makeRes();

    await handleCoreChatRoutes(makeCtx({ executeApiTask, stopChatTask: vi.fn() }), makeReq(runBody()), res, 'POST', '/api/core-chat/runs');

    await eventually(() => expect(fetch).toHaveBeenCalledTimes(2));
    const beforeAnswer = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(beforeAnswer[0].type).toBe('state');
    expect(beforeAnswer[1]).toMatchObject({
      seq: 2,
      type: 'question',
      payload: { toolUseId: 'tool-1', autoAnswer: false },
    });

    const answerRes = makeRes();
    await handleCoreChatRoutes(
      makeCtx({ executeApiTask, stopChatTask: vi.fn() }),
      makeReq({ toolUseId: 'tool-1', answer: 'Use option A' }),
      answerRes,
      'POST',
      '/api/core-chat/runs/run-1/answer',
    );
    expect(answerRes.json()).toMatchObject({ status: 'answered', answered: true });

    await eventually(() => expect(fetch).toHaveBeenCalledTimes(3));
    const events = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(events[2].type).toBe('complete');
    expect(events[2].payload.result.responseText).toContain('Use option A');
  });

  it('terminalizes API errors that arrive as non-final state updates', async () => {
    const executeApiTask = vi.fn(async ({ onUpdate }: any) => {
      const state: CardState = {
        status: 'running',
        userPrompt: 'hello',
        responseText: 'API Error: Request rejected (429) · This request would exceed your account rate limit.',
        toolCalls: [],
      };
      onUpdate(state, 'bridge-msg-429', false);
      return new Promise(() => {});
    });
    const stopChatTask = vi.fn(() => true);
    const ctx = makeCtx({ executeApiTask, stopChatTask });
    const postRes = makeRes();

    await handleCoreChatRoutes(ctx, makeReq(runBody()), postRes, 'POST', '/api/core-chat/runs');

    await eventually(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const events = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('state');
    expect(events[1]).toMatchObject({
      seq: 2,
      type: 'error',
      payload: {
        messageId: 'bridge-msg-429',
        final: true,
        error: expect.stringContaining('Request rejected (429)'),
      },
    });

    const cancelRes = makeRes();
    await handleCoreChatRoutes(ctx, makeReq({}), cancelRes, 'POST', '/api/core-chat/runs/run-1/cancel');
    expect(cancelRes.json()).toMatchObject({ runId: 'run-1', status: 'not_running', stopped: false });
    expect(stopChatTask).not.toHaveBeenCalled();
  });

  it('cancels an active run by runId via stopChatTask', async () => {
    const executeApiTask = vi.fn(async () => new Promise(() => {}));
    const stopChatTask = vi.fn(() => true);
    const ctx = makeCtx({ executeApiTask, stopChatTask });
    const postRes = makeRes();
    await handleCoreChatRoutes(ctx, makeReq(runBody()), postRes, 'POST', '/api/core-chat/runs');

    const cancelRes = makeRes();
    const handled = await handleCoreChatRoutes(ctx, makeReq({}), cancelRes, 'POST', '/api/core-chat/runs/run-1/cancel');

    expect(handled).toBe(true);
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json()).toMatchObject({ runId: 'run-1', status: 'canceled', stopped: true });
    expect(stopChatTask).toHaveBeenCalledWith('core-conv-1-metabot');
  });

  it('rejects unknown bots without peer forwarding', async () => {
    const ctx = {
      ...makeCtx({ executeApiTask: vi.fn(), stopChatTask: vi.fn() }),
      registry: { get: () => undefined } as any,
    };
    const res = makeRes();

    await handleCoreChatRoutes(ctx, makeReq(runBody({ targetBot: 'peer-only' })), res, 'POST', '/api/core-chat/runs');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Bot not found: peer-only' });
  });
});

describe('buildCoreChatCapabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to browser speech plus Edge TTS when Doubao keys are absent', () => {
    vi.stubEnv('VOLCENGINE_TTS_APPID', '');
    vi.stubEnv('VOLCENGINE_TTS_ACCESS_KEY', '');
    const capabilities = buildCoreChatCapabilities(makeCtx({ executeApiTask: vi.fn(), stopChatTask: vi.fn() }));

    expect(capabilities).toMatchObject({
      voice: {
        browserSpeechRecognition: { mode: 'client-side' },
        stt: { defaultProvider: 'whisper' },
        tts: { defaultProvider: 'edge' },
      },
    });
  });
});

describe('postCoreChatRunEvent', () => {
  it('retries the same event body and sequence number', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const event = {
      runId: 'run-1',
      seq: 7,
      type: 'state' as const,
      createdAt: '2026-06-11T00:00:00.000Z',
      bridge: { botName: 'metabot', executionChatId: 'core-conv-1-metabot' },
      payload: { state: { status: 'running' } },
    };

    await postCoreChatRunEvent('https://core.example/events', event, {
      attempts: 2,
      retryDelayMs: 0,
      fetchImpl: fetchImpl as any,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].body).toBe(fetchImpl.mock.calls[1][1].body);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).seq).toBe(7);
  });

  it('includes callback response body when all retry attempts fail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"callback_agent_owner_required"}',
    });
    const event = {
      runId: 'run-1',
      seq: 1,
      type: 'state' as const,
      createdAt: '2026-06-11T00:00:00.000Z',
      bridge: { botName: 'pico', executionChatId: 'core-conv-1-pico' },
      payload: { state: { status: 'running' } },
    };

    await expect(postCoreChatRunEvent('https://core.example/events', event, {
      attempts: 1,
      retryDelayMs: 0,
      fetchImpl: fetchImpl as any,
    })).rejects.toThrow('callback_agent_owner_required');
  });
});
