import { describe, expect, it, vi } from 'vitest';
import type * as lark from '@larksuiteoapi/node-sdk';
import { MessageSender } from '../src/feishu/message-sender.js';
import { FeishuSenderAdapter } from '../src/feishu/feishu-sender-adapter.js';
import { feishuConversationId } from '../src/feishu/conversation.js';
import { withReplyContext } from '../src/bridge/reply-context.js';
import { createLogger } from '../src/utils/logger.js';
import type { IncomingMessage } from '../src/types.js';

const message: IncomingMessage = {
  chatId: 'chat-1', messageId: 'incoming-1', chatType: 'group',
  userId: 'user-1', text: 'hello', threadId: 'thread-1',
};
function setup() {
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'new' } });
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'reply' } });
  const sender = new MessageSender({ im: { v1: { message: { create, reply } } } } as unknown as lark.Client, createLogger('silent'));
  return { sender, adapter: new FeishuSenderAdapter(sender), create, reply };
}

describe('Feishu thread delivery', () => {
  it('routes persisted conversation addresses without an active incoming-message context', async () => {
    const { sender, reply, create } = setup();
    const id = feishuConversationId({ ...message, rootMessageId: 'root' });
    await sender.sendText(id, 'scheduled reply');
    expect(reply).toHaveBeenCalledWith({ path: { message_id: 'root' }, data: {
      content: JSON.stringify({ text: 'scheduled reply' }), msg_type: 'text', reply_in_thread: true,
    } });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['group', 'p2p'])('keeps cards, notices, questions, text and media in a %s thread', async (chatType) => {
    const { sender, adapter, create, reply } = setup();
    const card = { status: 'running' as const, userPrompt: 'hello', responseText: '', toolCalls: [] };
    await withReplyContext({ ...message, chatType }, async () => {
      expect(await adapter.sendCard('chat-1', card)).toBe('reply');
      await adapter.sendQuestionCard('chat-1', card);
      await adapter.sendTextNotice('chat-1', 'Done', 'done');
      await adapter.sendText('chat-1', 'done');
      await sender.sendImage('chat-1', 'image-key');
      await sender.sendFile('chat-1', 'file-key');
      await sender.sendAudio('chat-1', 'audio-key');
    });
    expect(create).not.toHaveBeenCalled();
    expect(reply.mock.calls.map(([request]) => request.data.msg_type)).toEqual([
      'interactive', 'interactive', 'interactive', 'text', 'image', 'file', 'audio',
    ]);
    for (const [request] of reply.mock.calls) {
      expect(request.path).toEqual({ message_id: 'incoming-1' });
      expect(request.data.reply_in_thread).toBe(true);
    }
  });

  it.each([{ rootMessageId: 'root' }, { parentMessageId: 'parent' }])('supports reply events without thread_id: %j', async (fields) => {
    const { sender, reply } = setup();
    await withReplyContext({ ...message, threadId: undefined, ...fields }, () => sender.sendText('chat-1', 'hi'));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'incoming-1' } }));
  });

  it('preserves ordinary chat delivery and never leaks a thread into another chat', async () => {
    const { sender, create, reply } = setup();
    await withReplyContext({ ...message, threadId: undefined }, () => sender.sendText('chat-1', 'normal'));
    await withReplyContext({ ...message, chatType: 'p2p', threadId: undefined }, () => sender.sendText('chat-1', 'private'));
    await withReplyContext(message, () => sender.sendText('chat-2', 'other chat'));
    await sender.sendText('chat-1', 'outside task');
    expect(create).toHaveBeenCalledTimes(4);
    expect(reply).not.toHaveBeenCalled();
  });

  it('isolates overlapping turns and clears an inherited thread for a queued main-chat turn', async () => {
    const { sender, reply, create } = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withReplyContext(message, async () => {
      await gate;
      await sender.sendText('chat-1', 'first');
      await withReplyContext({ ...message, threadId: undefined }, () => sender.sendText('chat-1', 'main'));
    });
    await withReplyContext({ ...message, messageId: 'incoming-2', threadId: 'thread-2' }, () => sender.sendText('chat-1', 'second'));
    release();
    await first;
    expect(reply.mock.calls.map(([request]) => request.path.message_id)).toEqual(['incoming-2', 'incoming-1']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['exception', 'api-error'])('never falls back to the main chat on thread reply failure: %s', async (failure) => {
    const { sender, reply, create } = setup();
    if (failure === 'exception') reply.mockRejectedValue(new Error('message deleted'));
    else reply.mockResolvedValue({ code: 230011, msg: 'message deleted' });
    await withReplyContext(message, async () => {
      expect(await sender.sendCard('chat-1', '{}')).toBeUndefined();
      expect(await sender.sendImage('chat-1', 'key')).toBe(false);
      await sender.sendText('chat-1', 'hi');
    });
    expect(create).not.toHaveBeenCalled();
  });
});
