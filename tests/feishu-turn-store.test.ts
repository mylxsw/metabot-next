import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuTurnStore } from '../src/feishu/turn-store.js';
import { FeishuSenderAdapter } from '../src/feishu/feishu-sender-adapter.js';
import { feishuConversationId } from '../src/feishu/conversation.js';
import type { MessageSender } from '../src/feishu/message-sender.js';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const state = { status: 'complete' as const, userPrompt: 'How does it work?', responseText: 'One specific answer.', toolCalls: [] };
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-turn-'));
  directories.push(directory);
  const raw = { sendCard: vi.fn(async () => 'om_root'), updateCard: vi.fn(async () => true), getMessageText: vi.fn(async () => 'legacy root text') };
  return { directory, raw, adapter: new FeishuSenderAdapter(raw as unknown as MessageSender, new FeishuTurnStore(directory)) };
}
const topic = (chatId = 'oc_chat') => feishuConversationId({ chatId, messageId: 'reply', rootMessageId: 'om_root', chatType: 'p2p', userId: 'u', text: 'why?' });
describe('Feishu topic origin', () => {
  it('loads only the selected turn after a restart, including its latest streamed answer', async () => {
    const { raw, adapter, directory } = setup();
    await adapter.sendCard('oc_chat', { ...state, responseText: '' });
    await adapter.updateCard('om_root', state);
    const restored = new FeishuSenderAdapter(raw as unknown as MessageSender, new FeishuTurnStore(directory));
    expect(await restored.getThreadContext(topic())).toBe('User: How does it work?\nAssistant: One specific answer.');
    expect(raw.getMessageText).not.toHaveBeenCalled();
    expect(await restored.getThreadContext('oc_chat')).toBeUndefined();
  });
  it('does not seed a turn from another chat and can read legacy cards', async () => {
    const { adapter, raw } = setup();
    await adapter.sendCard('other-chat', state);
    expect(await adapter.getThreadContext(topic())).toBe('legacy root text');
    expect(raw.getMessageText).toHaveBeenCalledWith('oc_chat', 'om_root');
  });
  it('resolves question-card actions to their own conversation, not the main chat', async () => {
    const { adapter } = setup();
    await adapter.sendQuestionCard(topic(), state);
    expect(await adapter.resolveCardConversation('oc_chat', 'om_root')).toBe(topic());
    expect(await adapter.resolveCardConversation('other-chat', 'om_root')).toBeUndefined();
  });
});
