import type * as http from 'node:http';
import type { Credential } from '../auth/credentials.js';
import type { AgentStore, AgentRecord } from '../agents/agent-store.js';
import type { ChatStore } from '../chat/chat-store.js';
import type { ChatRunPresentation } from '../chat/chat-types.js';
import type { BusEventHub } from './event-hub.js';
import { MessageStore, type MessageSession } from './message-store.js';

export interface MessageRouteDeps {
  agents: AgentStore;
  messages: MessageStore;
  chat: ChatStore;
  events: BusEventHub;
  deliverRun?: (run: {
    id: string;
    conversationId: string;
    triggerMessageId: string;
    targetAgentRef: string;
    prompt: string;
    engine?: string | null;
    model?: string | null;
    presentation?: ChatRunPresentation | null;
  }) => void;
}
export interface RouteResult {
  status: number;
  body: unknown;
}
const err = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({
  status,
  body: { error, ...extra },
});
const senderRef = (cred: Credential) => (cred.ownerName || cred.botName).toLowerCase();

function resolveAgent(store: AgentStore, ref: string, cred: Credential): AgentRecord | null {
  const agent = store.getByName(ref) || store.getById(ref);
  if (!agent) return null;
  if (
    cred.role === 'admin' ||
    agent.visible ||
    (!!cred.ownerName && (agent.ownerName === cred.ownerName || agent.visibleToOwners.includes(cred.ownerName)))
  )
    return agent;
  return null;
}

function sessionShape(s: MessageSession): MessageSession {
  return s;
}

function isFeishuChatId(value: string): boolean {
  return /^oc_[A-Za-z0-9_-]{3,240}$/.test(value);
}

function originProxyPresentation(
  body: Record<string, unknown>,
  cred: Credential,
  targetAgentRef: string,
  agents: AgentStore,
): ChatRunPresentation | undefined {
  if (body.presentationMode !== 'origin-proxy') return undefined;
  const chatId = typeof body.originChatId === 'string' ? body.originChatId.trim() : '';
  const originBotName = typeof body.originBotName === 'string' ? body.originBotName.trim() : '';
  const senderNames = new Set([cred.botName.trim().toLowerCase(), cred.ownerName.trim().toLowerCase()].filter(Boolean));
  const adminSelectedRegisteredOrigin = cred.role === 'admin' && !!agents.getByName(originBotName);
  if (
    !isFeishuChatId(chatId) ||
    !originBotName ||
    (!senderNames.has(originBotName.toLowerCase()) && !adminSelectedRegisteredOrigin)
  ) {
    throw Object.assign(new Error('invalid_origin_proxy_presentation'), { statusCode: 400 });
  }
  return {
    mode: 'origin-proxy',
    chatId,
    targetAgentRef,
    requestedBy: cred.botName,
    originBotName,
    wakeLead: body.wakeLead !== false,
  };
}

export function registerSession(deps: MessageRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const ref = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const agent = resolveAgent(deps.agents, ref || cred.botName, cred);
  if (!agent) return err(404, 'agent_not_found');
  if (cred.role !== 'admin' && agent.ownerCredentialId !== cred.id && agent.ownerName !== cred.ownerName)
    return err(403, 'session_ownership_required');
  const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
  // Bind a provider session back to the central logical session that created
  // this room. The Bridge's local SessionRegistry UUID is not a Bus address.
  const roomSession = roomId ? deps.messages.findSessionByRoom(agent.id, roomId) : null;
  const session = deps.messages.ensureSession({
    agentId: agent.id,
    agentName: agent.botName,
    id: roomSession?.id ?? (typeof body.sessionId === 'string' ? body.sessionId : undefined),
    provider: typeof body.provider === 'string' ? body.provider : undefined,
    providerSessionId: typeof body.providerSessionId === 'string' ? body.providerSessionId : undefined,
    status: typeof body.status === 'string' ? (body.status as MessageSession['status']) : 'online',
    roomId: roomId || undefined,
    transportChatId: typeof body.transportChatId === 'string' ? body.transportChatId.trim() : undefined,
    transportPlatform: typeof body.transportPlatform === 'string' ? body.transportPlatform.trim() : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
  });
  return { status: 201, body: { session: sessionShape(session) } };
}

export function listSessions(
  deps: MessageRouteDeps,
  agentRef: string,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const agent = resolveAgent(deps.agents, agentRef, cred);
  if (!agent) return err(404, 'agent_not_found');
  const limit = Math.max(1, Math.min(100, Number(query.get('limit') || 20) || 20));
  const offset = Math.max(0, Number(query.get('offset') || 0) || 0);
  const result = deps.messages.listSessions(agent.id, { limit, offset });
  return {
    status: 200,
    body: {
      agentId: agent.id,
      agentName: agent.botName,
      ...result,
      limit,
      offset,
      hasMore: offset + result.sessions.length < result.total,
      nextOffset: offset + result.sessions.length < result.total ? offset + result.sessions.length : null,
    },
  };
}

export function sendMessage(deps: MessageRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const ref = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!ref) return err(400, 'agent_id_required');
  const text =
    typeof body.message === 'string' ? body.message.trim() : typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return err(400, 'message_required');
  const agent = resolveAgent(deps.agents, ref, cred);
  if (!agent) return err(404, 'agent_not_found');
  const listed = deps.messages.listSessions(agent.id, { limit: 100, offset: 0 }).sessions;
  const requested = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  let session = requested ? deps.messages.getSession(requested) : null;
  if (requested && (!session || session.agentId !== agent.id)) return err(404, 'session_not_found');
  if (!session) {
    const usable = listed.filter((s) => s.status === 'online' || s.status === 'resumable');
    if (usable.length > 1)
      return err(409, 'session_required', { sessions: usable, agentId: agent.id, agentName: agent.botName });
    if (usable.length === 1) session = usable[0]!;
    else if (listed.length > 0 && listed.every((s) => s.status === 'offline'))
      return err(409, 'session_offline', { sessions: listed, agentId: agent.id, agentName: agent.botName });
    else if (listed.length === 1 && listed[0]!.status === 'provisioning') session = listed[0]!;
    else if (listed.some((s) => s.status === 'provisioning'))
      return err(409, 'session_provisioning', { sessions: listed, agentId: agent.id, agentName: agent.botName });
  }
  const from = senderRef(cred);
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!session) {
    const room = deps.chat.createConversation({
      kind: 'dm',
      title: agent.botName,
      createdBy: from,
      participants: [{ kind: 'agent', ref: agent.botName, displayName: agent.botName }],
    });
    session = deps.messages.ensureSession({
      agentId: agent.id,
      agentName: agent.botName,
      status: 'provisioning',
      roomId: room.id,
    });
  } else if (!session.roomId) {
    const room = deps.chat.createConversation({
      kind: 'dm',
      title: session.title || agent.botName,
      createdBy: from,
      participants: [{ kind: 'agent', ref: agent.botName, displayName: agent.botName }],
    });
    session = deps.messages.ensureSession({
      agentId: agent.id,
      agentName: agent.botName,
      id: session.id,
      roomId: room.id,
    });
  }
  let presentation: ChatRunPresentation | undefined;
  try {
    presentation = originProxyPresentation(body, cred, agent.botName, deps.agents);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    return err(typeof statusCode === 'number' ? statusCode : 400, (error as Error).message || 'invalid_presentation');
  }
  if (
    !presentation &&
    body.presentationMode !== 'implicit' &&
    session.transportPlatform === 'feishu' &&
    typeof session.transportChatId === 'string' &&
    isFeishuChatId(session.transportChatId)
  ) {
    presentation = {
      mode: 'child-direct',
      chatId: session.transportChatId,
      targetAgentRef: agent.botName,
      requestedBy: cred.botName,
    };
  }
  if (idempotencyKey) {
    const prior = deps.chat.getRunByIdempotency(from, idempotencyKey);
    if (prior) {
      if (prior.targetAgentRef !== agent.botName) return err(409, 'idempotency_key_target_mismatch');
      if (prior.conversationId !== session.roomId) return err(409, 'idempotency_key_session_mismatch');
      if (JSON.stringify(prior.presentation) !== JSON.stringify(presentation ?? null))
        return err(409, 'idempotency_key_presentation_mismatch');
      return {
        status: 202,
        body: {
          ok: true,
          idempotentReplay: true,
          messageId: prior.triggerMessageId,
          sessionId: session.id,
          runId: prior.id,
          correlationId: prior.id,
          agentId: agent.id,
          agentName: agent.botName,
        },
      };
    }
  }
  const { message, run, idempotentReplay } = deps.chat.appendMessageAndCreateRun(
    {
      conversationId: session.roomId!,
      kind: 'user',
      senderKind: 'user',
      senderRef: from,
      senderDisplayName: from,
      content: text,
      mentionedAgentRefs: [],
      replyTo: typeof body.replyTo === 'string' ? body.replyTo : undefined,
      senderSessionId: typeof body.senderSessionId === 'string' ? body.senderSessionId : undefined,
    },
    {
      conversationId: session.roomId!,
      targetAgentRef: agent.botName,
      idempotencyOwner: idempotencyKey ? from : undefined,
      idempotencyKey: idempotencyKey || undefined,
      presentation,
    },
  );
  if (idempotentReplay) {
    return {
      status: 202,
      body: {
        ok: true,
        idempotentReplay: true,
        messageId: message.id,
        sessionId: session.id,
        runId: run.id,
        correlationId: run.id,
        agentId: agent.id,
        agentName: agent.botName,
      },
    };
  }
  deps.events.publish({
    type: 'message.created',
    roomId: session.roomId,
    agentRef: agent.botName,
    messageId: message.id,
    runId: run.id,
    correlationId: run.id,
    payload: { sessionId: session.id },
  });
  deps.events.publish({
    type: 'run.available',
    roomId: session.roomId,
    agentRef: agent.botName,
    messageId: message.id,
    runId: run.id,
    correlationId: run.id,
    payload: { sessionId: session.id },
  });
  deps.deliverRun?.({
    id: run.id,
    conversationId: session.roomId!,
    triggerMessageId: message.id,
    targetAgentRef: agent.botName,
    prompt: text,
    engine: run.engine,
    model: run.model,
    presentation: run.presentation,
  });
  return {
    status: 202,
    body: {
      ok: true,
      messageId: message.id,
      sessionId: session.id,
      runId: run.id,
      correlationId: run.id,
      agentId: agent.id,
      agentName: agent.botName,
    },
  };
}

export function ackMessage(deps: MessageRouteDeps, id: string, cred: Credential): RouteResult {
  const canonical = deps.chat.getMessage(id);
  if (canonical) {
    const run = deps.chat.getRunByTriggerMessageId(id);
    if (!run) return err(409, 'message_not_bus_run');
    const agent = deps.agents.getByName(run.targetAgentRef);
    if (!agent) return err(404, 'agent_not_found');
    if (cred.role !== 'admin' && agent.ownerCredentialId !== cred.id && agent.ownerName !== cred.ownerName)
      return err(403, 'message_ack_ownership_required');
    const session = deps.messages.findSessionByRoom(agent.id, run.conversationId);
    const deliveryStatus = run.status === 'queued' ? 'pending' : 'acked';
    return {
      status: 200,
      body: {
        ok: true,
        canonical: true,
        message: {
          id: canonical.id,
          agentId: agent.id,
          sessionId: session?.id,
          senderAgentId: canonical.senderRef,
          senderSessionId: canonical.senderSessionId,
          text: canonical.content,
          replyTo: canonical.replyTo,
          createdAt: canonical.createdAt,
          status: deliveryStatus,
        },
        runId: run.id,
        deliveryStatus: run.status,
      },
    };
  }
  const legacy = deps.messages.getMessage(id);
  if (!legacy) return err(404, 'message_not_found');
  const agent = deps.agents.getById(legacy.agentId);
  if (agent && cred.role !== 'admin' && agent.ownerCredentialId !== cred.id && agent.ownerName !== cred.ownerName)
    return err(403, 'message_ack_ownership_required');
  const updated = deps.messages.ackMessage(id)!;
  return { status: 200, body: { ok: true, legacy: true, message: updated } };
}

export function streamMessages(
  deps: MessageRouteDeps,
  query: URLSearchParams,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cred: Credential,
): RouteResult | void {
  const ref = query.get('agentId') || query.get('agent') || '';
  const agent = resolveAgent(deps.agents, ref, cred);
  if (!agent) return err(404, 'agent_not_found');
  deps.events.subscribe(
    req,
    res,
    (event) =>
      event.agentRef === agent.botName &&
      (!query.get('sessionId') || event.payload?.sessionId === query.get('sessionId')),
  );
}
