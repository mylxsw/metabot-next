import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { OutputsManager } from '../src/bridge/outputs-manager.js';
import { createLogger } from '../src/utils/logger.js';
import { describe, expect, it, vi } from 'vitest';
import { feishuConversationId, parseFeishuConversation } from '../src/feishu/conversation.js';

const message = { chatId: 'oc_chat', messageId: 'om_root', userId: 'u1', text: 'hello', chatType: 'p2p' };

describe('Feishu conversation addresses', () => {
  it('preserves main-chat keys and separates topics from chats and each other', () => {
    expect(feishuConversationId(message)).toBe('oc_chat');
    const a = feishuConversationId({ ...message, threadId: 'omt_a' });
    const reply = feishuConversationId({ ...message, messageId: 'reply', rootMessageId: 'om_root', parentMessageId: 'other', userId: 'u2' });
    expect(a).toBe(reply);
    expect(a).not.toBe(feishuConversationId({ ...message, rootMessageId: 'om_b' }));
    expect(a).not.toBe(feishuConversationId({ ...message, chatId: 'other', threadId: 'omt_a' }));
    expect(parseFeishuConversation(a)).toEqual({ chatId: 'oc_chat', rootMessageId: 'om_root' });
    expect(feishuConversationId({ ...message, chatId: a })).toBe(a);
    expect(a).not.toMatch(/[/:\\]/);
  });
  it('persists topic isolation and reset state, including separate output directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-persist-'));
    vi.stubEnv('SESSION_STORE_DIR', dir);
    const logger = createLogger('silent');
    const a = feishuConversationId({ ...message, rootMessageId: 'root-a' });
    const b = feishuConversationId({ ...message, rootMessageId: 'root-b' });
    const first = new SessionManager(dir, logger, 'bot-a');
    first.setSessionId(message.chatId, 'main-session');
    first.setSessionId(a, 'topic-a-session');
    first.setSessionId(b, 'topic-b-session');
    first.resetSession(a);
    first.destroy();
    const restored = new SessionManager(dir, logger, 'bot-a');
    const otherBot = new SessionManager(dir, logger, 'bot-b');
    try {
      expect(restored.getSession(a).sessionId).toBeUndefined();
      expect(restored.getSession(a).threadContextInitialized).toBe(true);
      expect(restored.getSession(b).sessionId).toBe('topic-b-session');
      expect(restored.getSession(message.chatId).sessionId).toBe('main-session');
      expect(otherBot.getSession(b).sessionId).toBeUndefined();
      const outputs = new OutputsManager(path.join(dir, 'outputs'), logger);
      expect(new Set([a, b, message.chatId].map(id => outputs.prepareDir(id))).size).toBe(3);
    } finally {
      restored.destroy(); otherBot.destroy(); vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed scoped addresses instead of sending to the main chat', () => {
    expect(() => parseFeishuConversation('feishu-thread-invalid')).toThrow();
  });
});
