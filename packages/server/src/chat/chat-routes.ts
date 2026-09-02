import type * as http from 'node:http';
import type { Credential } from '../auth/credentials.js';
import type { AgentRecord, AgentStore } from '../agents/agent-store.js';
import type { ChatStore } from './chat-store.js';
import type { ChatEventHub } from './chat-events.js';
import { ChatForbiddenError, ChatNotFoundError } from './chat-store.js';
import type {
  ChatParticipantCandidate,
  ChatParticipantKind,
  ChatRun,
  ChatRunEvent,
  ChatRunEventKind,
} from './chat-types.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

export interface ChatRouteDeps {
  chat: ChatStore;
  agents: AgentStore;
  events: ChatEventHub;
  deliverRun?: (run: {
    id: string;
    conversationId: string;
    triggerMessageId: string;
    targetAgentRef: string;
    prompt: string;
    engine?: string | null;
    model?: string | null;
  }) => void;
  deliverControl?: (control: {
    runId: string;
    targetAgentRef: string;
    action: 'answer' | 'cancel';
    toolUseId?: string;
    answer?: string;
  }) => void;
  onRunEvent?: (run: ChatRun, event: ChatRunEvent) => void;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

function userRef(cred: Credential): string {
  return cred.ownerName || cred.botName;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseParticipants(body: Record<string, unknown>): Array<{
  kind: ChatParticipantKind;
  ref: string;
  displayName?: string;
}> {
  const raw = Array.isArray(body.participants) ? body.participants : [];
  const out: Array<{ kind: ChatParticipantKind; ref: string; displayName?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const kind = p.kind === 'agent' ? 'agent' : p.kind === 'user' ? 'user' : null;
    const rawRef = typeof p.ref === 'string' ? p.ref.trim() : '';
    const ref = kind === 'user' ? rawRef.toLowerCase() : rawRef;
    if (!kind || !ref) continue;
    const displayName = typeof p.displayName === 'string' ? p.displayName : undefined;
    out.push({ kind, ref, displayName });
  }
  return out;
}

function parseLimit(query: URLSearchParams, defaultLimit: number, maxLimit: number): number {
  const raw = query.get('limit');
  const parsed = raw ? Number.parseInt(raw, 10) : defaultLimit;
  if (!Number.isFinite(parsed)) return defaultLimit;
  return Math.min(Math.max(parsed, 1), maxLimit);
}

function isEmailRef(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function visibleAgent(store: AgentStore, botName: string, cred: Credential): AgentRecord | null {
  const agent = store.getByName(botName);
  if (!agent) return null;
  if (cred.role === 'admin') return agent;
  if (agent.visible) return agent;
  if (cred.ownerName && agent.ownerName === cred.ownerName) return agent;
  if (cred.ownerName && agent.visibleToOwners.includes(cred.ownerName)) return agent;
  return null;
}

function ensureAgentRefsVisible(store: AgentStore, refs: string[], cred: Credential): RouteResult | null {
  for (const ref of refs) {
    if (!visibleAgent(store, ref, cred)) return err(404, 'agent_not_found');
  }
  return null;
}

function listVisibleAgents(store: AgentStore, cred: Credential): AgentRecord[] {
  const all = store.list({ includeHidden: true });
  return all.filter((agent) => {
    if (cred.role === 'admin') return true;
    if (agent.visible) return true;
    if (cred.ownerName && agent.ownerName === cred.ownerName) return true;
    if (cred.ownerName && agent.visibleToOwners.includes(cred.ownerName)) return true;
    return false;
  });
}

function withChatErrors(fn: () => RouteResult): RouteResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ChatNotFoundError) return err(404, 'conversation_not_found');
    if (e instanceof ChatForbiddenError) return err(403, 'chat_participant_required');
    const sc = (e as { statusCode?: number }).statusCode;
    if (typeof sc === 'number') return err(sc, (e as Error).message || 'error');
    throw e;
  }
}

function parseEventKind(value: unknown): ChatRunEventKind | null {
  if (
    value === 'state' ||
    value === 'complete' ||
    value === 'question' ||
    value === 'file' ||
    value === 'log' ||
    value === 'error'
  )
    return value;
  return null;
}

export function listConversations(deps: ChatRouteDeps, cred: Credential): RouteResult {
  return { status: 200, body: { conversations: deps.chat.listConversationsForUser(userRef(cred)) } };
}

export function createConversation(deps: ChatRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const kind = body.kind === 'dm' ? 'dm' : 'group';
  const participants = parseParticipants(body);
  const agentRefs = participants.filter((p) => p.kind === 'agent').map((p) => p.ref);
  const agentErr = ensureAgentRefsVisible(deps.agents, agentRefs, cred);
  if (agentErr) return agentErr;
  const title = typeof body.title === 'string' ? body.title : undefined;
  return withChatErrors(() => ({
    status: 201,
    body: deps.chat.createConversation({
      kind,
      title,
      createdBy: userRef(cred),
      participants,
    }),
  }));
}

export function findOrCreateAgentDm(deps: ChatRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const botName = typeof body.botName === 'string' ? body.botName.trim() : '';
  if (!botName) return err(400, 'bot_name_required');
  const agent = visibleAgent(deps.agents, botName, cred);
  if (!agent) return err(404, 'agent_not_found');
  return {
    status: 200,
    body: deps.chat.findOrCreateAgentDm({
      userRef: userRef(cred),
      agentRef: agent.botName,
      agentDisplayName: agent.botName,
    }),
  };
}

export function findOrCreateUserDm(deps: ChatRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const rawRef =
    typeof body.userRef === 'string' ? body.userRef.trim() : typeof body.email === 'string' ? body.email.trim() : '';
  const otherUserRef = rawRef.toLowerCase();
  if (!otherUserRef) return err(400, 'user_ref_required');
  if (!isEmailRef(otherUserRef)) return err(400, 'user_ref_email_required');
  const displayName = typeof body.displayName === 'string' ? body.displayName : undefined;
  return withChatErrors(() => ({
    status: 200,
    body: deps.chat.findOrCreateUserDm({
      userRef: userRef(cred),
      otherUserRef,
      otherDisplayName: displayName,
    }),
  }));
}

export function searchParticipants(deps: ChatRouteDeps, query: URLSearchParams, cred: Credential): RouteResult {
  const q = (query.get('q') || '').trim();
  if (!q) return { status: 200, body: { participants: [] } };
  const qLower = q.toLowerCase();
  const limit = parseLimit(query, 20, 50);
  const out = new Map<string, ChatParticipantCandidate>();
  const add = (candidate: ChatParticipantCandidate) => {
    const key = `${candidate.kind}:${candidate.ref}`;
    if (!out.has(key)) out.set(key, candidate);
  };

  if (isEmailRef(qLower)) {
    add({ kind: 'user', ref: qLower, displayName: qLower, source: 'exact' });
  }
  for (const user of deps.chat.searchKnownUsers(qLower, limit)) add(user);

  const agents = listVisibleAgents(deps.agents, cred)
    .filter((agent) => agent.botName.toLowerCase().includes(qLower))
    .sort((a, b) => a.botName.localeCompare(b.botName))
    .slice(0, limit);
  for (const agent of agents) {
    add({ kind: 'agent', ref: agent.botName, displayName: agent.botName, source: 'agent' });
  }

  return { status: 200, body: { participants: [...out.values()].slice(0, limit) } };
}

export function getConversation(deps: ChatRouteDeps, id: string, cred: Credential): RouteResult {
  return withChatErrors(() => ({
    status: 200,
    body: deps.chat.getConversationForUser(id, userRef(cred)),
  }));
}

export function listParticipants(deps: ChatRouteDeps, id: string, cred: Credential): RouteResult {
  return withChatErrors(() => ({
    status: 200,
    body: { participants: deps.chat.listParticipants(id, userRef(cred)) },
  }));
}

/** Open a participant-scoped SSE stream for live conversation updates. */
export function streamConversation(
  deps: ChatRouteDeps,
  id: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cred: Credential,
): RouteResult | null {
  try {
    deps.chat.getConversationForUser(id, userRef(cred));
  } catch (e) {
    if (e instanceof ChatNotFoundError) return err(404, 'conversation_not_found');
    if (e instanceof ChatForbiddenError) return err(403, 'chat_participant_required');
    throw e;
  }
  deps.events.stream(req, res, id, userRef(cred));
  return null;
}

export function addParticipant(
  deps: ChatRouteDeps,
  id: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const kind = body.kind === 'agent' ? 'agent' : body.kind === 'user' ? 'user' : null;
  const rawRef = typeof body.ref === 'string' ? body.ref.trim() : '';
  const ref = kind === 'user' ? rawRef.toLowerCase() : rawRef;
  if (!kind || !ref) return err(400, 'participant_required');
  if (kind === 'agent') {
    const agentErr = ensureAgentRefsVisible(deps.agents, [ref], cred);
    if (agentErr) return agentErr;
  }
  const displayName = typeof body.displayName === 'string' ? body.displayName : undefined;
  return withChatErrors(() => ({
    status: 201,
    body: deps.chat.addParticipant(id, userRef(cred), { kind, ref, displayName }),
  }));
}

export function listMessages(deps: ChatRouteDeps, id: string, query: URLSearchParams, cred: Credential): RouteResult {
  const limitRaw = query.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const before = query.get('before') || undefined;
  return withChatErrors(() => ({
    status: 200,
    body: { messages: deps.chat.listMessages(id, userRef(cred), { limit, before }) },
  }));
}

export function postMessage(
  deps: ChatRouteDeps,
  id: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const content = typeof body.content === 'string' ? body.content : '';
  const engine = parseEngine(body.engine);
  const model = typeof body.model === 'string' ? body.model.trim() : undefined;
  return withChatErrors(() => ({
    status: 201,
    body: postMessageUnchecked(deps, id, content, cred, { engine, model }),
  }));
}

function postMessageUnchecked(
  deps: ChatRouteDeps,
  id: string,
  content: string,
  cred: Credential,
  options: { engine?: string; model?: string } = {},
) {
  const user = userRef(cred);
  const conversation = deps.chat.getConversationForUser(id, user);
  const participants = deps.chat.listParticipants(id, user);
  const agentParticipants = participants.filter((p) => p.kind === 'agent').map((p) => p.ref);
  const mentionedAgentRefs = parseMentionedAgentRefs(content, agentParticipants);
  const message = deps.chat.appendMessage({
    conversationId: id,
    kind: 'user',
    senderKind: 'user',
    senderRef: user,
    senderDisplayName: user,
    content,
    mentionedAgentRefs,
    runId: null,
  });
  const triggerAgentRefs = conversation.kind === 'dm' ? agentParticipants : mentionedAgentRefs;
  const runs = triggerAgentRefs.map((targetAgentRef) =>
    deps.chat.createRun({
      conversationId: id,
      triggerMessageId: message.id,
      targetAgentRef,
      engine: options.engine,
      model: options.model,
    }),
  );
  for (const run of runs) {
    deps.deliverRun?.({
      id: run.id,
      conversationId: id,
      triggerMessageId: message.id,
      targetAgentRef: run.targetAgentRef,
      prompt: content,
      engine: run.engine,
      model: run.model,
    });
  }
  return {
    message,
    agentTriggers: mentionedAgentRefs,
    runsCreated: runs.length,
    runs,
  };
}

function parseEngine(value: unknown): 'claude' | 'kimi' | 'codex' | undefined {
  return value === 'claude' || value === 'kimi' || value === 'codex' ? value : undefined;
}

function parseMentionedAgentRefs(content: string, agentRefs: string[]): string[] {
  const out: string[] = [];
  for (const ref of agentRefs) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)@${escaped}(?=\\s|$|[,.!?;:])`, 'i');
    if (re.test(content)) out.push(ref);
  }
  return out;
}

export function markRead(
  deps: ChatRouteDeps,
  id: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const messageId = body.messageId === null ? null : typeof body.messageId === 'string' ? body.messageId : null;
  return withChatErrors(() => ({
    status: 200,
    body: deps.chat.markRead(id, userRef(cred), messageId),
  }));
}

export function listRuns(deps: ChatRouteDeps, id: string, cred: Credential): RouteResult {
  return withChatErrors(() => ({
    status: 200,
    body: { runs: deps.chat.listRuns(id, userRef(cred)) },
  }));
}

export function listRunEvents(deps: ChatRouteDeps, runId: string, cred: Credential): RouteResult {
  return withChatErrors(() => ({
    status: 200,
    body: { events: deps.chat.listRunEventsForUser(runId, userRef(cred)) },
  }));
}

export function answerRun(
  deps: ChatRouteDeps,
  runId: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  return withChatErrors(() => {
    const run = deps.chat.getRunForUser(runId, userRef(cred));
    if (run.status !== 'waiting_user' && run.status !== 'running') return err(409, 'run_not_waiting');
    const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId.trim() : '';
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!toolUseId || !answer) return err(400, 'tool_use_id_and_answer_required');
    deps.deliverControl?.({
      runId,
      targetAgentRef: run.targetAgentRef,
      action: 'answer',
      toolUseId,
      answer,
    });
    return { status: 202, body: { runId, status: 'answer_queued' } };
  });
}

export function cancelRun(deps: ChatRouteDeps, runId: string, cred: Credential): RouteResult {
  return withChatErrors(() => {
    const run = deps.chat.getRunForUser(runId, userRef(cred));
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return { status: 200, body: { runId, status: run.status, queued: false } };
    }
    deps.deliverControl?.({
      runId,
      targetAgentRef: run.targetAgentRef,
      action: 'cancel',
    });
    return { status: 202, body: { runId, status: 'cancel_queued', queued: true } };
  });
}

export function listFiles(deps: ChatRouteDeps, id: string, cred: Credential): RouteResult {
  return withChatErrors(() => ({
    status: 200,
    body: { files: deps.chat.listFiles(id, userRef(cred)) },
  }));
}

export function postRunEvent(
  deps: ChatRouteDeps,
  runId: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  if (cred.authSource === 'web') return err(404, 'not_found');
  const run = deps.chat.getRun(runId);
  if (!run) return err(404, 'run_not_found');
  const agent = deps.agents.getByName(run.targetAgentRef);
  if (!agent) return err(403, 'callback_agent_not_registered');
  if (cred.role !== 'admin' && agent.ownerCredentialId !== cred.id) {
    return err(403, 'callback_agent_owner_required');
  }
  const kind = parseEventKind(body.kind ?? body.type);
  if (!kind) return err(400, 'event_kind_required');
  const seq = typeof body.seq === 'number' ? body.seq : Number.parseInt(String(body.seq ?? ''), 10);
  return withChatErrors(() => {
    const event = deps.chat.appendRunEvent({
      runId,
      seq,
      kind,
      payload: asObject(body.payload),
    });
    const next = deps.chat.getRun(runId);
    if (next) deps.onRunEvent?.(next, event);
    return { status: 200, body: event };
  });
}
