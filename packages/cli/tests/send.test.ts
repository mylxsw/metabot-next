import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.METABOT_CORE_TOKEN = 'mt_test_tok';
  process.env.METABOT_CORE_URL = 'https://example.test/core';
  process.env.HOME = '/tmp/metabot-cli-test-home-does-not-exist';
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIG_ENV };
});

async function importFresh(): Promise<typeof import('../src/send.js')> {
  vi.resetModules();
  return await import('../src/send.js');
}

describe('metabot send', () => {
  it('prints help without reading config or making requests', async () => {
    process.env.METABOT_CORE_TOKEN = '';
    process.env.METABOT_CORE_URL = '';
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['--help']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'metabot send - minimal durable Agent Bus message',
    );
  });

  it('posts a minimal message with an exact session', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://example.test/core/api/messages');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        agentId: 'superagent',
        message: 'hello',
        sessionId: 'session_1',
      });
      return new Response(JSON.stringify({ ok: true, messageId: 'msg_1', sessionId: 'session_1', runId: 'run_1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['superagent', 'hello', '--session', 'session_1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('"runId": "run_1"');
  });

  it('supports implicit and origin-proxy presentation modes', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, runId: `run_${bodies.length}` }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('METABOT_ORIGIN_CHAT', 'oc_origin_chat');
    vi.stubEnv('METABOT_ORIGIN_BOT', 'metabot');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['superagent', 'background only', '--implicit']);
    await mod.run(['superagent', 'run this']);
    await mod.run(['superagent', 'direct', '--child-direct']);

    expect(bodies).toEqual([
      { agentId: 'superagent', message: 'background only', presentationMode: 'implicit' },
      {
        agentId: 'superagent',
        message: 'run this',
        presentationMode: 'origin-proxy',
        originChatId: 'oc_origin_chat',
        originBotName: 'metabot',
      },
      { agentId: 'superagent', message: 'direct' },
    ]);
  });
});
