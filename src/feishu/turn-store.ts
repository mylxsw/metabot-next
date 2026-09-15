import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { CardState } from '../types.js';

interface Turn { chatId: string; userPrompt: string; responseText: string }

/** Persist only the displayed turn, so new topics need not copy a session history. */
export class FeishuTurnStore {
  constructor(private directory: string) {}

  private file(messageId: string): string {
    return path.join(this.directory, createHash('sha256').update(messageId).digest('hex') + '.json');
  }

  get(messageId: string): Turn | undefined {
    try {
      const turn = JSON.parse(fs.readFileSync(this.file(messageId), 'utf8'));
      if (typeof turn.chatId === 'string' && typeof turn.userPrompt === 'string' && typeof turn.responseText === 'string') return turn;
    } catch { /* Missing snapshots are expected for older cards. */ }
    return undefined;
  }

  save(messageId: string, state: CardState, chatId?: string): void {
    const existing = this.get(messageId);
    const owner = chatId ?? existing?.chatId;
    if (!owner) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(messageId);
    fs.writeFileSync(target + '.tmp', JSON.stringify({
      chatId: owner, userPrompt: state.userPrompt, responseText: state.responseText,
    }), { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  }
}
