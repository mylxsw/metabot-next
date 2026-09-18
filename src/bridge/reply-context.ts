import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from '../types.js';

// A reply belongs to the triggering message, never to the latest active chat.
// Async scope keeps concurrent and queued turns from overwriting each other.
const replyContext = new AsyncLocalStorage<{ chatId: string; messageId?: string }>();

export function withReplyContext<T>(message: IncomingMessage, run: () => T): T {
  // Feishu supports threads in both group chats and bot direct messages.
  const inThread = Boolean(message.threadId || message.rootMessageId || message.parentMessageId);
  return replyContext.run({
    chatId: message.chatId,
    messageId: inThread ? message.messageId : undefined,
  }, run);
}

export function getReplyMessageId(chatId: string): string | undefined {
  const context = replyContext.getStore();
  return context?.chatId === chatId ? context.messageId : undefined;
}
