import type { TelegramGroupReplyMode } from './group-reply-mode-store.js';

export interface TelegramMessageEntityLike {
  type: string;
  offset?: number;
  length?: number;
}

export interface TelegramGroupRoutingOptions {
  botMentioned: boolean;
  isCommand: boolean;
  storedMode?: TelegramGroupReplyMode;
  configGroupNoMention?: boolean;
  privateLikeGroup?: boolean;
}

export interface TelegramGroupReplyModeCommand {
  action: 'status' | 'set' | 'help';
  mode?: TelegramGroupReplyMode;
}

export function isTelegramUserAllowed(allowedUserIds: string[] | undefined, userId: string): boolean {
  return !allowedUserIds?.length || allowedUserIds.includes(userId);
}

export function isTelegramBotMentioned(
  text: string,
  entities: readonly TelegramMessageEntityLike[] | undefined,
  botUsername: string | undefined,
): boolean {
  if (!botUsername || !entities?.some((entity) => entity.type === 'mention')) return false;
  return new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'i').test(text);
}

export function stripTelegramBotMention(text: string, botUsername: string | undefined): string {
  if (!botUsername) return text.trim();
  return text.replace(new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'gi'), '').trim();
}

export function normalizeTelegramCommandSuffix(text: string, botUsername: string | undefined): string {
  if (!botUsername) return text;
  return text.replace(new RegExp(`^(\\/[\\p{L}\\w-]+)@${escapeRegExp(botUsername)}(?=\\s|$)`, 'iu'), '$1');
}

export function isTelegramGroupReplyCommandAddressed(text: string, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  return new RegExp(
    `^\\/(?:group-reply|group_reply|group_mode|群回复)@${escapeRegExp(botUsername)}(?=\\s|$)`,
    'i',
  ).test(text.trim());
}

export function parseTelegramGroupReplyModeCommand(text: string): TelegramGroupReplyModeCommand | undefined {
  const match = text.trim().match(/^\/(?:group-reply|group_reply|group_mode|群回复)(?:\s+(.+))?$/i);
  if (!match) return undefined;
  const arg = match[1]?.trim().toLowerCase();
  if (!arg || arg === 'status' || arg === '状态') return { action: 'status' };
  if (['mention', 'at', '@', '仅@', '只@', '必须@'].includes(arg)) {
    return { action: 'set', mode: 'mention' };
  }
  if (['all', '全部', '所有消息', '全量'].includes(arg)) {
    return { action: 'set', mode: 'all' };
  }
  return { action: 'help' };
}

export function shouldProcessTelegramGroupMessage(options: TelegramGroupRoutingOptions): boolean {
  if (options.botMentioned || options.isCommand) return true;
  if (options.storedMode) return options.storedMode === 'all';
  return options.configGroupNoMention === true || options.privateLikeGroup === true;
}

export class TelegramMemberCountCache {
  private cache = new Map<string, { count: number; timestamp: number }>();

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  async isTwoMemberGroup(chatId: string, getMemberCount: () => Promise<number>): Promise<boolean> {
    const cached = this.cache.get(chatId);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) return cached.count === 2;
    const count = await getMemberCount();
    this.cache.set(chatId, { count, timestamp: Date.now() });
    return count === 2;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
