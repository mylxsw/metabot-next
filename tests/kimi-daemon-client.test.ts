import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { KimiDaemonClient, KimiDaemonError } from '../src/engines/kimi/daemon-client.js';

function response<T>(data: T): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data, request_id: 'req-test' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KimiDaemonClient', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'metabot-kimi-client-'));
    previousHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    await writeFile(path.join(home, 'server.token'), 'test-token\n', { mode: 0o600 });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('starts the web daemon without opening a browser and allows more than 15 seconds', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('not running'))
      .mockResolvedValueOnce(response({ ok: true })));
    // Probe succeeds 16 seconds after launch: within the 30-second startup window.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(16_000);
    await new KimiDaemonClient({ executable: '/test/kimi', serverUrl: 'http://127.0.0.1:58628' }).ensureRunning();
    expect(spawn).toHaveBeenCalledWith('/test/kimi', ['web', '--port', '58628', '--no-open'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }));
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('does not spawn a daemon when one is already healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ok: true })));
    await new KimiDaemonClient().ensureRunning();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the official prompt queue and steer endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(
        response({ prompt_id: 'prompt-steer', user_message_id: 'message-steer', status: 'queued' }),
      )
      .mockResolvedValueOnce(response({ steered: true, prompt_ids: ['prompt-steer'] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KimiDaemonClient();

    await client.steer('session-1', 'also optimize mobile', {
      model: 'kimi-code/k3',
      thinking: 'high',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/sessions/session-1/prompts');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      content: [{ type: 'text', text: 'also optimize mobile' }],
      permission_mode: 'auto',
      model: 'kimi-code/k3',
      thinking: 'high',
    });
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/api/v1/sessions/session-1/prompts:steer');
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual({
      prompt_ids: ['prompt-steer'],
    });
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('does not replay a prompt when its response is lost', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockRejectedValueOnce(new Error('socket closed after request'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KimiDaemonClient();

    await expect(client.submitPrompt('session-1', 'run this once')).rejects.toThrow(
      'Kimi Code server request failed: socket closed after request',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/sessions/session-1/prompts');
  });

  it('probes again before a later POST after a daemon transport failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockRejectedValueOnce(new Error('daemon exited during create'))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ id: 'session-recovered' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KimiDaemonClient();

    await expect(client.createSession('/tmp/first')).rejects.toThrow(
      'Kimi Code server request failed: daemon exited during create',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(client.createSession('/tmp/second')).resolves.toMatchObject({
      id: 'session-recovered',
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/healthz');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/sessions');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/api/v1/healthz');
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/api/v1/sessions');
  });

  it('reconnects and retries a bodyless GET after a transport failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockRejectedValueOnce(new Error('stale connection'))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ as_of_seq: 17 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KimiDaemonClient();

    await expect(client.getSnapshot('session-1')).resolves.toMatchObject({ as_of_seq: 17 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/sessions/session-1/snapshot');
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/api/v1/sessions/session-1/snapshot');
  });

  it('resolves short model names against the live Kimi Code config', async () => {
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'default_model = "kimi-code/k3"',
        '',
        '[models."kimi-code/k3"]',
        'display_name = "Kimi K3"',
        '',
        '[models."kimi-code/kimi-for-coding-highspeed"]',
        'display_name = "Kimi Highspeed"',
      ].join('\n'),
    );
    const client = new KimiDaemonClient();

    await expect(client.resolveModel('k3')).resolves.toEqual({ id: 'kimi-code/k3', displayName: 'Kimi K3' });
    await expect(client.resolveModel('kimi-for-coding-highspeed')).resolves.toEqual({
      id: 'kimi-code/kimi-for-coding-highspeed',
      displayName: 'Kimi Highspeed',
    });
  });

  it('rejects non-loopback servers before reading or sending the local daemon token', () => {
    expect(() => new KimiDaemonClient({ serverUrl: 'https://kimi.example.com' })).toThrow(KimiDaemonError);
  });
});
