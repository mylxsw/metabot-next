import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config.js';
import {
  TelegramMemberCountCache,
  isTelegramBotMentioned,
  isTelegramGroupReplyCommandAddressed,
  isTelegramUserAllowed,
  normalizeTelegramCommandSuffix,
  parseTelegramGroupReplyModeCommand,
  shouldProcessTelegramGroupMessage,
  stripTelegramBotMention,
} from '../src/telegram/group-policy.js';
import { TelegramGroupReplyModeStore } from '../src/telegram/group-reply-mode-store.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Telegram group policy', () => {
  it('allows only configured Telegram users when an allowlist is present', () => {
    expect(isTelegramUserAllowed(undefined, '1')).toBe(true);
    expect(isTelegramUserAllowed([], '1')).toBe(true);
    expect(isTelegramUserAllowed(['1'], '1')).toBe(true);
    expect(isTelegramUserAllowed(['1'], '2')).toBe(false);
  });

  it('matches and strips only the current bot mention', () => {
    const entities = [{ type: 'mention', offset: 0, length: 14 }];
    expect(isTelegramBotMentioned('@wednesday_bot hello', entities, 'wednesday_bot')).toBe(true);
    expect(isTelegramBotMentioned('@other_bot hello', entities, 'wednesday_bot')).toBe(false);
    expect(stripTelegramBotMention('@wednesday_bot hello', 'wednesday_bot')).toBe('hello');
  });

  it('normalizes Telegram command suffixes and requires an addressed group-mode command', () => {
    const raw = '/group_reply@wednesday_bot all';
    expect(isTelegramGroupReplyCommandAddressed(raw, 'wednesday_bot')).toBe(true);
    expect(isTelegramGroupReplyCommandAddressed('/group-reply all', 'wednesday_bot')).toBe(false);
    expect(normalizeTelegramCommandSuffix(raw, 'wednesday_bot')).toBe('/group_reply all');
    expect(parseTelegramGroupReplyModeCommand('/group_reply all')).toEqual({ action: 'set', mode: 'all' });
    expect(parseTelegramGroupReplyModeCommand('/群回复 状态')).toEqual({ action: 'status' });
  });

  it('uses explicit mode before config and two-member defaults', () => {
    expect(shouldProcessTelegramGroupMessage({ botMentioned: true, isCommand: false })).toBe(true);
    expect(shouldProcessTelegramGroupMessage({ botMentioned: false, isCommand: true })).toBe(true);
    expect(
      shouldProcessTelegramGroupMessage({
        botMentioned: false,
        isCommand: false,
        storedMode: 'mention',
        configGroupNoMention: true,
        privateLikeGroup: true,
      }),
    ).toBe(false);
    expect(
      shouldProcessTelegramGroupMessage({
        botMentioned: false,
        isCommand: false,
        storedMode: 'all',
      }),
    ).toBe(true);
    expect(
      shouldProcessTelegramGroupMessage({
        botMentioned: false,
        isCommand: false,
        privateLikeGroup: true,
      }),
    ).toBe(true);
  });

  it('caches Telegram member counts', async () => {
    const getMemberCount = vi.fn(async () => 2);
    const cache = new TelegramMemberCountCache(60_000);
    await expect(cache.isTwoMemberGroup('chat-1', getMemberCount)).resolves.toBe(true);
    await expect(cache.isTwoMemberGroup('chat-1', getMemberCount)).resolves.toBe(true);
    expect(getMemberCount).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramGroupReplyModeStore', () => {
  it('persists an explicit mode per bot and chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-telegram-group-mode-'));
    const dbPath = join(dir, 'modes.db');
    const store = new TelegramGroupReplyModeStore(logger, dbPath);
    store.set('wednesday', '-1001', 'all', '7554625724');
    expect(store.get('wednesday', '-1001')).toBe('all');
    expect(store.get('other', '-1001')).toBeUndefined();
    store.close();

    const reopened = new TelegramGroupReplyModeStore(logger, dbPath);
    expect(reopened.get('wednesday', '-1001')).toBe('all');
    reopened.close();
  });
});

describe('Telegram config', () => {
  it('loads group reply and user allowlist settings from bots.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-telegram-config-'));
    const configPath = join(dir, 'bots.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        telegramBots: [
          {
            name: 'wednesday',
            telegramBotToken: '123:fake',
            defaultWorkingDirectory: dir,
            groupNoMention: true,
            allowedUserIds: ['7554625724'],
          },
        ],
      }),
    );
    vi.stubEnv('BOTS_CONFIG', configPath);

    const config = loadAppConfig().telegramBots[0];
    expect(config.groupNoMention).toBe(true);
    expect(config.allowedUserIds).toEqual(['7554625724']);
  });
});
