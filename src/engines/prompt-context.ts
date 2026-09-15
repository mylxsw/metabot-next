export interface ApiContext {
  botName: string;
  chatId: string;
  /** Platform chat ID when the MetaBot conversation address includes a topic. */
  transportChatId?: string;
  /** Session-level engine selected for this chat. */
  engine?: 'claude' | 'kimi' | 'codex';
  /** Current engine session id when one already exists; diagnostic only. */
  sessionId?: string;
  /** Compact current Team roster and dispatch hint; never includes task/message/run history. */
  teamContext?: string;
  /** Group chat member names — enables inter-bot communication prompt. */
  groupMembers?: string[];
  /** Group ID — used to build grouptalk chatIds for inter-bot communication. */
  groupId?: string;
}

function compactContextValue(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, 200);
}

/** Stable, engine-neutral current-chat context used by every executor. */
export function buildMetaBotApiPromptContext(apiContext: ApiContext): string {
  const botName = compactContextValue(apiContext.botName, 'metabot');
  const chatId = compactContextValue(apiContext.chatId, 'unknown');
  const sessionId = apiContext.sessionId
    ? compactContextValue(apiContext.sessionId, 'unknown')
    : 'not established yet (a new Session will be created automatically)';

  return [
    '## Current MetaBot Context',
    `Agent: ${botName}`,
    `Chat ID: ${compactContextValue(apiContext.transportChatId, chatId)}`,
    ...(apiContext.transportChatId && apiContext.transportChatId !== apiContext.chatId
      ? [`Conversation address: ${chatId} (use this for MetaBot session, task and schedule commands)`]
      : []),
    `Engine: ${apiContext.engine ?? 'default'}`,
    `Session ID: ${sessionId}`,
    'Session ID is diagnostic and may change after reset or an engine switch. Schedules target Agent + conversation address (Chat ID when no topic is present).',
    '',
    'Schedule in this chat:',
    `- One-time: \`metabot schedule add ${botName} ${chatId} <delaySeconds> "<prompt>"\``,
    `- Recurring: \`metabot schedule cron ${botName} ${chatId} "<cronExpr>" "<prompt>"\``,
    '',
    'Use the /metabot skill for Memory, T5T, Agent Bus, Agent Teams, scheduling, and runtime operations.',
  ].join('\n');
}
