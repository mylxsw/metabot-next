import { afterEach, describe, expect, it } from 'vitest';
import { call, startTestServer, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;
afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

async function issue(k: ServerKit, botName: string, ownerName = botName) {
  const r = await call(k.baseUrl, 'POST', '/admin/credentials/issue', k.adminToken, {
    botName,
    ownerName,
    role: 'member',
  });
  expect(r.status).toBe(201);
  return { token: r.body.token as string, credentialId: r.body.credential.id as string };
}

describe('minimal message protocol', () => {
  it('creates a logical session on first send and reuses it', async () => {
    kit = await startTestServer('minimal-message');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const first = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, { agentId: rec.id, message: 'hello' });
    expect(first.status).toBe(202);
    expect(first.body.sessionId).toEqual(expect.any(String));
    const listed = await call(kit.baseUrl, 'GET', `/api/agents/${encodeURIComponent(rec.id)}/sessions`, sender.token);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(1);
    const logicalSession = listed.body.sessions[0] as { id: string; roomId: string };
    const providerMirror = await call(kit.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
      agentId: rec.id,
      sessionId: 'bridge-local-session-id',
      roomId: logicalSession.roomId,
      provider: 'codex',
      providerSessionId: 'codex-thread-id',
      status: 'resumable',
      transportChatId: 'oc_target_chat',
      transportPlatform: 'feishu',
    });
    expect(providerMirror.status).toBe(201);
    expect(providerMirror.body.session).toMatchObject({
      id: first.body.sessionId,
      provider: 'codex',
      providerSessionId: 'codex-thread-id',
      status: 'resumable',
      transportChatId: 'oc_target_chat',
      transportPlatform: 'feishu',
    });
    expect(kit.handle.messageStore.listSessions(rec.id).total).toBe(1);
    const second = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: 'target',
      sessionId: first.body.sessionId,
      message: 'again',
    });
    expect(second.status).toBe(202);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(kit.handle.chatStore.getRun(String(second.body.runId))?.presentation).toEqual({
      mode: 'child-direct',
      chatId: 'oc_target_chat',
      targetAgentRef: 'target',
      requestedBy: 'sender',
    });

    const implicit = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: 'target',
      sessionId: first.body.sessionId,
      message: 'background only',
      presentationMode: 'implicit',
    });
    expect(implicit.status).toBe(202);
    expect(kit.handle.chatStore.getRun(String(implicit.body.runId))?.presentation).toBeNull();
  });

  it('uses the ChatStore message as the canonical record', async () => {
    kit = await startTestServer('minimal-message-canonical-record');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const sent = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      message: 'canonical message',
      replyTo: 'prior-message',
      senderSessionId: 'sender-session',
      idempotencyKey: 'canonical-key',
    });
    expect(sent.status).toBe(202);
    const message = kit.handle.chatStore.getMessage(String(sent.body.messageId));
    expect(message).toMatchObject({
      id: sent.body.messageId,
      content: 'canonical message',
      replyTo: 'prior-message',
      senderSessionId: 'sender-session',
    });
    expect((kit.handle.db.prepare('SELECT COUNT(*) AS count FROM bus_messages').get() as { count: number }).count).toBe(
      0,
    );

    const replay = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      sessionId: sent.body.sessionId,
      message: 'canonical message',
      idempotencyKey: 'canonical-key',
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      idempotentReplay: true,
      messageId: sent.body.messageId,
      runId: sent.body.runId,
      sessionId: sent.body.sessionId,
    });
    expect((kit.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(1);

    const ack = await call(
      kit.baseUrl,
      'POST',
      `/api/messages/${encodeURIComponent(String(sent.body.messageId))}/ack`,
      owner.token,
    );
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ canonical: true, deliveryStatus: 'queued' });
    expect(ack.body.message).toMatchObject({ status: 'pending', text: 'canonical message' });
  });

  it('reuses a provisioning session instead of creating a second context', async () => {
    kit = await startTestServer('minimal-message-provisioning');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const first = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      message: 'first',
    });
    const second = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      message: 'second',
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(kit.handle.messageStore.listSessions(rec.id).total).toBe(1);
  });

  it('serializes concurrent idempotent sends into one run', async () => {
    kit = await startTestServer('minimal-message-concurrent-idempotency');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const results = await Promise.all(
      [1, 2].map(() =>
        call(kit!.baseUrl, 'POST', '/api/messages', sender.token, {
          agentId: rec.id,
          message: 'retry safely',
          idempotencyKey: 'concurrent-key',
        }),
      ),
    );
    expect(results.every((result) => result.status === 202)).toBe(true);
    expect(results[0]!.body.runId).toBe(results[1]!.body.runId);
    expect((kit.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(1);
  });

  it('forwards target-session presentation to the bridge relay payload', async () => {
    kit = await startTestServer('minimal-message-relay-presentation');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const seed = await call(kit.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
      agentId: rec.id,
      sessionId: 'target-feishu-session',
      provider: 'codex',
      providerSessionId: 'codex-thread-id',
      status: 'resumable',
      transportChatId: 'oc_target_chat',
      transportPlatform: 'feishu',
    });
    expect(seed.status).toBe(201);

    const sent = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      sessionId: 'target-feishu-session',
      message: 'hello target chat',
    });
    expect(sent.status).toBe(202);
    const relay = kit.handle.inboxStore.peek('target', undefined, 1)[0];
    expect(relay).toBeDefined();
    const payload = JSON.parse(relay!.content) as { request: { presentation?: unknown } };
    expect(payload.request.presentation).toEqual({
      mode: 'child-direct',
      chatId: 'oc_target_chat',
      targetAgentRef: 'target',
      requestedBy: 'sender',
    });
  });

  it('stores origin-proxy presentation and relays run events back to the sender bridge', async () => {
    kit = await startTestServer('minimal-message-origin-proxy');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const sent = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: 'target',
      message: 'run remotely',
      presentationMode: 'origin-proxy',
      originChatId: 'oc_origin_chat',
      originBotName: 'sender',
    });
    expect(sent.status).toBe(202);
    expect(kit.handle.chatStore.getRun(String(sent.body.runId))?.presentation).toEqual({
      mode: 'origin-proxy',
      chatId: 'oc_origin_chat',
      targetAgentRef: 'target',
      requestedBy: 'sender',
      originBotName: 'sender',
      wakeLead: true,
    });

    const event = await call(kit.baseUrl, 'POST', `/api/chat/runs/${sent.body.runId}/events`, owner.token, {
      seq: 1,
      kind: 'complete',
      payload: { content: 'remote result', state: { responseText: 'remote result', toolCalls: [] } },
    });
    expect(event.status).toBe(200);
    const projection = kit.handle.inboxStore.peek('sender', `core-chat-proxy:${sent.body.runId}`, 1)[0];
    expect(projection).toBeDefined();
    expect(JSON.parse(projection!.content)).toMatchObject({
      type: 'core-chat-proxy',
      targetAgentRef: 'target',
      originChatId: 'oc_origin_chat',
      wakeLead: true,
      event: { seq: 1, kind: 'complete' },
    });
  });

  it('allows an admin to project through a registered origin bot', async () => {
    kit = await startTestServer('minimal-message-admin-origin-proxy');
    const target = await issue(kit, 'target-owner', 'target@example.com');
    kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: target.credentialId,
      ownerName: 'target@example.com',
    });
    const sent = await call(kit.baseUrl, 'POST', '/api/messages', kit.adminToken, {
      agentId: 'target',
      message: 'project from admin',
      presentationMode: 'origin-proxy',
      originChatId: 'oc_admin_origin_chat',
      originBotName: 'target',
    });
    expect(sent.status).toBe(202);
    expect(kit.handle.chatStore.getRun(String(sent.body.runId))?.presentation).toMatchObject({
      mode: 'origin-proxy',
      chatId: 'oc_admin_origin_chat',
      originBotName: 'target',
    });
  });

  it('searches by username with bounded pagination', async () => {
    kit = await startTestServer('minimal-search');
    const token = await issue(kit, 'searcher', 'alice@example.com');
    kit.handle.agentStore.register({
      botName: 'robot-a',
      url: 'inbox:',
      description: 'vision',
      ownerCredentialId: 'owner-a',
      ownerName: 'bob@example.com',
    });
    kit.handle.agentStore.register({
      botName: 'robot-b',
      url: 'inbox:',
      description: 'planning',
      ownerCredentialId: 'owner-b',
      ownerName: 'alice@example.com',
    });
    const result = await call(kit.baseUrl, 'GET', '/api/agents/search?user=alice@example.com&limit=1', token.token);
    expect(result.status).toBe(200);
    expect(result.body.agents).toHaveLength(1);
    expect(result.body.hasMore).toBe(false);
  });
});
