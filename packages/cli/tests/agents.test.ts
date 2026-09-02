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

async function importFresh(): Promise<typeof import('../src/agents.js')> {
  vi.resetModules();
  return await import('../src/agents.js');
}

describe('metabot agents registry', () => {
  it('prints registry help without exposing Agent Bus delivery commands or reading config', async () => {
    process.env.METABOT_CORE_TOKEN = '';
    process.env.METABOT_CORE_URL = '';
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['--help']);

    expect(fetchMock).not.toHaveBeenCalled();
    const output = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('metabot send <agentId>');
    expect(output).toContain('remove  <botName>');
    expect(output).not.toContain('talk <peer>');
  });

  it('removes an owned registry row through the core delete route', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://example.test/core/api/agents/bus-live-receiver-1');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ botName: 'bus-live-receiver-1', removed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['remove', 'bus-live-receiver-1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join(''))).toEqual({
      botName: 'bus-live-receiver-1',
      removed: true,
    });
  });
});
