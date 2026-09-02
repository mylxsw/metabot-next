import { describe, expect, it, vi } from 'vitest';
import { getTelegramCommands, registerTelegramCommands } from '../src/telegram/command-menu.js';

function setup() {
  return {
    api: { setMyCommands: vi.fn().mockResolvedValue(true) },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('Telegram native command menu', () => {
  it('publishes implemented commands and limits group_reply to groups', () => {
    const common = ['help', 'reset', 'stop', 'status', 'model', 'effort', 'resume', 'memory'];
    for (const language of ['', 'zh'] as const) {
      expect(getTelegramCommands('default', language).map((c) => c.command)).toEqual(common);
      expect(getTelegramCommands('all_private_chats', language).map((c) => c.command)).toEqual(common);
      expect(getTelegramCommands('all_group_chats', language).map((c) => c.command)).toEqual([
        ...common,
        'group_reply',
      ]);
    }
  });

  it('uses valid, unique Telegram command names and bounded localized descriptions', () => {
    for (const language of ['', 'zh'] as const) {
      const commands = getTelegramCommands('all_group_chats', language);
      expect(commands.length).toBeLessThanOrEqual(100);
      expect(new Set(commands.map((c) => c.command)).size).toBe(commands.length);
      for (const command of commands) {
        expect(command.command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(command.description.length).toBeGreaterThan(0);
        expect(command.description.length).toBeLessThanOrEqual(256);
        if (language === 'zh') expect(command.description).toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });

  it('registers default, private and group scopes in fallback English and Chinese', async () => {
    const { api, logger } = setup();
    await registerTelegramCommands(api, logger);
    expect(api.setMyCommands).toHaveBeenCalledTimes(6);
    for (const scope of ['default', 'all_private_chats', 'all_group_chats'] as const) {
      for (const language of ['', 'zh'] as const) {
        expect(api.setMyCommands).toHaveBeenCalledWith(
          getTelegramCommands(scope, language),
          { scope: { type: scope }, ...(language ? { language_code: language } : {}) },
          expect.any(AbortSignal),
        );
      }
    }
    expect(logger.info).toHaveBeenCalledTimes(6);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('continues other scopes after a failed request without logging credentials', async () => {
    const { api, logger } = setup();
    api.setMyCommands.mockRejectedValueOnce(new Error('request failed at /botSECRET/setMyCommands'));
    await expect(registerTelegramCommands(api, logger)).resolves.toBeUndefined();
    expect(api.setMyCommands).toHaveBeenCalledTimes(6);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET');
  });

  it('does not fail startup when every registration fails', async () => {
    const { api, logger } = setup();
    api.setMyCommands.mockRejectedValue(new Error('network unavailable'));
    await expect(registerTelegramCommands(api, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(6);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('bounds requests with an abort signal and continues after a timeout', async () => {
    const { api, logger } = setup();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    api.setMyCommands.mockImplementationOnce(
      (_commands, _options, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
        }),
    );
    try {
      const registration = registerTelegramCommands(api, logger);
      expect(timeout).toHaveBeenCalledWith(10_000);
      controller.abort();
      await expect(registration).resolves.toBeUndefined();
      expect(api.setMyCommands).toHaveBeenCalledTimes(6);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it('re-registers the same menus on restart and returns independent command arrays', async () => {
    const { api, logger } = setup();
    const commands = getTelegramCommands('default', '');
    commands[0].description = 'changed';
    expect(getTelegramCommands('default', '')[0].description).not.toBe('changed');
    await registerTelegramCommands(api, logger);
    await registerTelegramCommands(api, logger);
    expect(api.setMyCommands).toHaveBeenCalledTimes(12);
    expect(api.setMyCommands.mock.calls.slice(0, 6).map((call) => call.slice(0, 2))).toEqual(
      api.setMyCommands.mock.calls.slice(6).map((call) => call.slice(0, 2)),
    );
  });
});
