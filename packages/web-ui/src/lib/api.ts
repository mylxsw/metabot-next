import { clearApiToken, getApiToken } from './auth';

export type ContentType = 'text/markdown' | 'text/html';

export interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
  children: FolderTreeNode[];
  document_count: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content_type: ContentType;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentFull extends DocumentSummary {
  content: string;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  content_type: ContentType;
  snippet: string;
  tags: string[];
  created_by: string;
  updated_at: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  ownerBotName?: string;
  visibility: 'private' | 'published' | 'shared';
  contentHash: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
}

export interface SkillRecord extends SkillSummary {
  ownerCredentialId?: string;
  userInvocable: boolean;
  context?: string;
  allowedTools?: string;
  skillMd: string;
  hasReferences: boolean;
}

export interface SkillSearchResult extends SkillSummary {
  snippet: string;
}

export interface Manifest {
  schemaVersion: number;
  instance: { name: string };
  capabilities: {
    memory: boolean;
    skills: boolean;
    content_types: ContentType[];
  };
}

// ---- t5t (mirror of packages/server/src/t5t/types.ts — camelCase only) ----

export type ProjectStatus = 'green' | 'yellow' | 'red' | 'killed' | 'unknown';
export type WipStatus = 'queued' | 'doing' | 'done';
export type AnomalyReason = 'no_owner' | 'stale' | 'kill_red' | 'no_goal' | 'stale_bottleneck';

export interface Evaluator {
  project: string;
  evaluatorId: string;
  description: string;
  met: boolean;
  seq: number;
  author: string;
  authorCanonical: string;
  createdAt: string;
  docId: string;
}

export interface Bottleneck {
  project: string;
  bottleneckId: string;
  text: string;
  cleared: boolean;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  docId: string;
}

export interface WIPItem {
  project: string;
  evaluatorId: string;
  wipId: string;
  description: string;
  status: WipStatus;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  docId: string;
}

export type TopFiveStatus = 'open' | 'done' | 'removed';

export interface TopFiveItem {
  project: string;
  itemId: string;
  text: string;
  status: TopFiveStatus;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  docId: string;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  leaderEmail: string | null;
  allowedUsers: string[];
  status: ProjectStatus;
  killCriteria: string | null;
  goal: string | null;
  bottleneck: Bottleneck | null;
  evaluators: Evaluator[];
  lastPush: string | null;
  lastAuthor: string | null;
}

export interface T5TEntry {
  entryId: string;
  docId: string;
  author: string;
  authorCanonical: string;
  project: string;
  date: string;
  items: string[];
  retracts: string | null;
  createdAt: string;
}

export interface FeedbackEntry {
  feedbackId: string;
  docId: string;
  onEntry: string;
  from: string;
  fromCanonical: string;
  mentions: string[];
  comment: string;
  createdAt: string;
}

export interface AnomalyItem {
  project: string;
  reason: AnomalyReason;
  detail: string;
  lastPush: string | null;
}

export interface BoardResponse {
  generatedAt: string;
  projects: ProjectSummary[];
  recentEntries: T5TEntry[];
  anomalies: AnomalyItem[];
}

export interface WIPBoardColumn {
  evaluator: Evaluator;
  items: WIPItem[];
}

export interface ProjectDetailResponse {
  project: ProjectSummary;
  entries: T5TEntry[];
  feedback: FeedbackEntry[];
  wipBoard: WIPBoardColumn[];
  topFive: TopFiveItem[];
}

export interface TopFiveRequest {
  project: string;
  text?: string;
  itemId?: string;
  status?: TopFiveStatus;
}

export interface FeedbackRequest {
  onEntry: string;
  comment: string;
  mentions: string[];
}

// ---- agents (mirror of packages/server/src/agents/agent-routes.ts public shape) ----

export interface AgentSummary {
  botName: string;
  url: string;
  host: string;
  visible: boolean;
  ownerName?: string;
  lastSeenAt: string;
}

export interface WhoamiResponse {
  botName: string;
  ownerName: string;
  role: string;
  authSource: string;
  credentialId: string;
  memoryPublic: boolean;
}

// ---- chat ----

export type ChatConversationKind = 'dm' | 'group';
export type ChatParticipantKind = 'user' | 'agent';
export type ChatMessageKind = 'user' | 'assistant' | 'system';
export type ChatRunStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'canceled';

export interface ChatParticipant {
  conversationId: string;
  kind: ChatParticipantKind;
  ref: string;
  displayName: string;
  addedBy: string;
  addedAt: string;
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
  createdAt: string;
}

export interface ChatRunEvent {
  id?: string;
  runId: string;
  seq: number;
  kind?: 'state' | 'question' | 'file' | 'complete' | 'error' | 'log' | 'canceled' | string;
  type?: 'state' | 'question' | 'file' | 'complete' | 'error' | 'log' | 'canceled' | string;
  payload?: unknown;
  payloadJson?: unknown;
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

export interface ChatRun {
  id: string;
  conversationId: string;
  triggerMessageId: string | null;
  targetAgentRef: string;
  engine?: string | null;
  model?: string | null;
  status: ChatRunStatus;
  updatedAt: string;
  createdAt?: string;
  completedAt?: string | null;
  error?: string | null;
  events?: ChatRunEvent[];
}

export interface ChatConversation {
  id: string;
  kind: ChatConversationKind;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  participants: ChatParticipant[];
  lastMessage: ChatMessage | null;
  unreadCount: number;
}

export interface PostChatMessageResponse {
  message: ChatMessage;
  agentTriggers: string[];
  runsCreated: number;
  runs?: ChatRun[];
  runEvents?: ChatRunEvent[];
}

export interface ChatParticipantInput {
  kind: ChatParticipantKind;
  ref: string;
  displayName?: string;
}

export interface ChatParticipantSearchResult {
  kind: ChatParticipantKind;
  ref: string;
  displayName: string;
  source: 'exact' | 'known' | 'agent' | string;
}

export interface VoiceTranscribeResponse {
  success: boolean;
  transcript: string;
  error?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string,
  ) {
    super(`${status} ${code}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  const token = getApiToken();
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const code =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText || 'request_failed';
    if (res.status === 401) clearApiToken(true);
    throw new ApiError(res.status, code);
  }
  return body as T;
}

// Memory routes accept either a UUID id or a slash-prefixed path. Preserve
// slash separators and RFC-3986-safe path characters so deep links remain
// readable and work through ordinary self-hosted reverse proxies.
function encodePathSegment(seg: string): string {
  return encodeURIComponent(seg)
    .replace(/%40/g, '@')
    .replace(/%3A/g, ':')
    .replace(/%24/g, '$')
    .replace(/%26/g, '&')
    .replace(/%2B/g, '+')
    .replace(/%2C/g, ',')
    .replace(/%3B/g, ';')
    .replace(/%3D/g, '=')
    .replace(/%21/g, '!')
    .replace(/%27/g, "'")
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*');
}

function encodeIdOrPath(idOrPath: string): string {
  if (idOrPath.includes('/')) {
    return idOrPath.split('/').map(encodePathSegment).join('/');
  }
  return encodePathSegment(idOrPath);
}

export const api = {
  manifest: () => request<Manifest>('/api/manifest'),
  health: () => request<{ ok: true; uptime: number; version: string }>('/health'),

  folderTree: () => request<FolderTreeNode>('/api/memory/folders/tree'),
  listDocuments: (limit = 50) => request<{ documents: DocumentSummary[] }>(`/api/memory/documents?limit=${limit}`),
  listDocumentsByFolder: (folderId: string, limit = 200) =>
    request<{ documents: DocumentSummary[] }>(
      `/api/memory/documents?folder_id=${encodeURIComponent(folderId)}&limit=${limit}`,
    ),
  getDocument: (idOrPath: string) => request<DocumentFull>(`/api/memory/documents/${encodeIdOrPath(idOrPath)}`),
  getFolder: (idOrPath: string) =>
    request<{ id: string; name: string; path: string; parent_id: string | null }>(
      `/api/memory/folders/${encodeIdOrPath(idOrPath)}`,
    ),
  searchMemory: (q: string, limit = 20, offset = 0) =>
    request<{ results: SearchResult[] }>(
      `/api/memory/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    ),

  listSkills: () => request<{ skills: SkillSummary[] }>('/api/skills'),
  getSkill: (name: string) => request<SkillRecord>(`/api/skills/${encodeURIComponent(name)}`),
  searchSkills: (q: string) =>
    request<{ skills: SkillSearchResult[] }>(`/api/skills/search?q=${encodeURIComponent(q)}`),

  listAgents: () => request<{ agents: AgentSummary[] }>('/api/agents'),
  whoami: () => request<WhoamiResponse>('/api/whoami'),

  listChatConversations: () => request<{ conversations: ChatConversation[] }>('/api/chat/conversations'),
  getChatConversation: (id: string) => request<ChatConversation>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  createChatConversation: (
    kind: ChatConversationKind,
    title: string | undefined,
    participants: ChatParticipantInput[],
  ) =>
    request<ChatConversation>('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, title, participants }),
    }),
  findOrCreateAgentDm: (botName: string) =>
    request<ChatConversation>('/api/chat/conversations/agent-dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botName }),
    }),
  addChatParticipant: (conversationId: string, participant: ChatParticipantInput) =>
    request<ChatParticipant>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(participant),
    }),
  searchChatParticipants: (q: string, limit = 12) =>
    request<{ participants: ChatParticipantSearchResult[] }>(
      `/api/chat/participants/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  listChatRuns: (conversationId: string) =>
    request<{ runs: ChatRun[] }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/runs`),
  listChatRunEvents: (runId: string) =>
    request<{ events: ChatRunEvent[] }>(`/api/chat/runs/${encodeURIComponent(runId)}/events`),
  answerChatRun: (runId: string, toolUseId: string, answer: string) =>
    request<{ runId: string; status: string }>(`/api/chat/runs/${encodeURIComponent(runId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ toolUseId, answer }),
    }),
  cancelChatRun: (runId: string) =>
    request<{ runId: string; status: string; queued?: boolean }>(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listChatFiles: (conversationId: string) =>
    request<{ files: ChatFile[] }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/files`),
  listChatMessages: (conversationId: string, limit = 80) =>
    request<{ messages: ChatMessage[] }>(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
    ),
  postChatMessage: (
    conversationId: string,
    content: string,
    mentionedAgentRefs: string[],
    options?: { engine?: string; model?: string },
  ) =>
    request<PostChatMessageResponse>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, mentionedAgentRefs, ...options }),
    }),
  transcribeChatVoice: (audio: Blob, options?: { stt?: string; language?: string }) => {
    const qs = new URLSearchParams();
    qs.set('stt', options?.stt || 'doubao');
    qs.set('language', options?.language || 'zh');
    return request<VoiceTranscribeResponse>(`/api/chat/voice/transcribe?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
    });
  },
  markChatRead: (conversationId: string, messageId: string | null) =>
    request<{ conversationId: string; userRef: string; lastReadMessageId: string | null; lastReadAt: string }>(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      },
    ),

  getT5tBoard: () => request<BoardResponse>('/api/t5t/board'),
  getT5tProject: (slug: string) => request<ProjectDetailResponse>(`/api/t5t/projects/${encodeURIComponent(slug)}`),
  postT5tFeedback: (body: FeedbackRequest) =>
    request<FeedbackEntry>('/api/t5t/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  killT5tProject: (slug: string) =>
    request<ProjectSummary>(`/api/t5t/projects/${encodeURIComponent(slug)}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  postT5tTopFive: (body: TopFiveRequest) =>
    request<TopFiveItem>('/api/t5t/topfive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};
