import type { IncomingMessage } from '../types.js';

const PREFIX = 'feishu-thread-';

/** A durable conversation address: usable by sessions, queues and schedules. */
export function feishuConversationId(message: IncomingMessage): string {
  if (message.chatId.startsWith(PREFIX)) return message.chatId;
  if (!message.threadId && !message.rootMessageId && !message.parentMessageId) return message.chatId;
  const root = message.rootMessageId || message.parentMessageId || message.messageId;
  return PREFIX + Buffer.from(JSON.stringify([message.chatId, root])).toString('base64url');
}

/** Resolve a conversation address only at the Feishu transport boundary. */
export function parseFeishuConversation(id: string): { chatId: string; rootMessageId?: string } {
  if (!id.startsWith(PREFIX)) return { chatId: id };
  const parts: unknown = JSON.parse(Buffer.from(id.slice(PREFIX.length), 'base64url').toString('utf8'));
  if (!Array.isArray(parts) || parts.length !== 2 || parts.some(part => typeof part !== 'string' || !part)) {
    throw new Error('Invalid Feishu conversation address');
  }
  return { chatId: parts[0], rootMessageId: parts[1] };
}
