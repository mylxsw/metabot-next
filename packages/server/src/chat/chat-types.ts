export type ChatConversationKind = 'dm' | 'group';
export type ChatParticipantKind = 'user' | 'agent';
export type ChatMessageKind = 'user' | 'assistant' | 'system';
export type ChatRunStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'canceled';
export type ChatRunEventKind = 'state' | 'complete' | 'question' | 'file' | 'log' | 'error';
export interface ChatRunPresentation {
  mode: 'child-direct' | 'origin-proxy';
  chatId: string;
  targetAgentRef: string;
  requestedBy: string;
  originBotName?: string;
  wakeLead?: boolean;
  teamName?: string;
}

export interface ChatConversation {
  id: string;
  kind: ChatConversationKind;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

export interface ChatParticipant {
  conversationId: string;
  kind: ChatParticipantKind;
  ref: string;
  displayName: string;
  addedBy: string;
  addedAt: string;
}

export interface ChatParticipantCandidate {
  kind: ChatParticipantKind;
  ref: string;
  displayName: string;
  source: 'exact' | 'known' | 'agent';
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  kind: ChatMessageKind;
  senderKind: ChatParticipantKind;
  senderRef: string;
  senderDisplayName: string;
  content: string;
  mentionedAgentRefs: string[];
  runId: string | null;
  replyTo?: string;
  senderSessionId?: string;
  createdAt: string;
}

export interface ChatReadState {
  conversationId: string;
  userRef: string;
  lastReadMessageId: string | null;
  lastReadAt: string;
}

export interface ChatConversationSummary extends ChatConversation {
  participants: ChatParticipant[];
  lastMessage: ChatMessage | null;
  unreadCount: number;
}

export interface ChatRun {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  targetAgentRef: string;
  engine: string | null;
  model: string | null;
  status: ChatRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  finalMessageId: string | null;
  idempotencyOwner?: string | null;
  idempotencyKey?: string | null;
  presentation?: ChatRunPresentation | null;
}

export interface ChatRunEvent {
  id: string;
  runId: string;
  seq: number;
  kind: ChatRunEventKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ChatFile {
  id: string;
  conversationId: string;
  messageId: string | null;
  runId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  storageKey: string;
  createdBy: string;
  createdAt: string;
}

export type ChatLiveEvent =
  | { type: 'message.created'; conversationId: string; message: ChatMessage }
  | { type: 'run.updated'; conversationId: string; run: ChatRun }
  | { type: 'run.event'; conversationId: string; runId: string; event: ChatRunEvent }
  | { type: 'file.created'; conversationId: string; file: ChatFile };
