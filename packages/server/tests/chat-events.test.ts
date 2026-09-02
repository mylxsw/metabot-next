import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChatEventHub } from '../src/chat/chat-events.js';
import { ChatStore } from '../src/chat/chat-store.js';
import { makeKit } from './helpers.js';

function fakeResponse() {
  const writes: string[] = [];
  const response = new EventEmitter() as EventEmitter & {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string) => boolean;
    end: () => void;
  };
  response.writeHead = () => undefined;
  response.write = (chunk) => { writes.push(chunk); return true; };
  response.end = () => undefined;
  return { response, writes };
}

describe('ChatEventHub', () => {
  it('sends a participant-scoped snapshot and live message events', () => {
    const kit = makeKit('chat-events');
    try {
      const store = new ChatStore(kit.db, kit.logger);
      const conversation = store.createConversation({
        kind: 'dm',
        createdBy: 'alice@example.com',
        participants: [{ kind: 'user', ref: 'alice@example.com' }, { kind: 'agent', ref: 'bot' }],
      });
      const hub = new ChatEventHub(store, { heartbeatMs: 60_000 });
      const { response, writes } = fakeResponse();
      const req = new EventEmitter() as EventEmitter;

      hub.stream(req as never, response as never, conversation.id, 'alice@example.com');
      expect(writes[0]).toContain('event: snapshot');
      expect(JSON.parse(writes[0].split('data: ')[1]).messages).toEqual([]);
      expect(hub.clientCount(conversation.id)).toBe(1);

      store.appendMessage({
        conversationId: conversation.id,
        kind: 'user',
        senderKind: 'user',
        senderRef: 'alice@example.com',
        content: 'hello',
      });
      expect(writes.some((chunk) => chunk.includes('event: message.created') && chunk.includes('hello'))).toBe(true);

      req.emit('close');
      expect(hub.clientCount(conversation.id)).toBe(0);
    } finally {
      kit.cleanup();
    }
  });
});
