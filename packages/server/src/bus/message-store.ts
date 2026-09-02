import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export type MessageSessionStatus = 'online' | 'resumable' | 'offline' | 'provisioning';

export interface MessageSession {
  id: string;
  agentId: string;
  agentName: string;
  provider?: string;
  providerSessionId?: string;
  status: MessageSessionStatus;
  roomId?: string;
  transportChatId?: string;
  transportPlatform?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface MessageRecord {
  id: string;
  agentId: string;
  sessionId: string;
  senderAgentId: string;
  senderSessionId?: string;
  text: string;
  replyTo?: string;
  createdAt: string;
  status: 'pending' | 'acked';
}

export interface EnsureSessionInput {
  agentId: string;
  agentName: string;
  id?: string;
  provider?: string;
  providerSessionId?: string;
  status?: MessageSessionStatus;
  roomId?: string;
  transportChatId?: string;
  transportPlatform?: string;
  title?: string;
}

/** Small durable catalog for the simplified Agent Bus protocol. */
export class MessageStore {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        provider TEXT,
        provider_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'provisioning',
        room_id TEXT,
        transport_chat_id TEXT,
        transport_platform TEXT,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS message_sessions_agent_idx
        ON message_sessions(agent_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS message_sessions_agent_status_idx
        ON message_sessions(agent_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS bus_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        sender_session_id TEXT,
        text TEXT NOT NULL,
        reply_to TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bus_messages_session_idx
        ON bus_messages(session_id, created_at);
    `);
    const columns = this.db.prepare('PRAGMA table_info(bus_messages)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'idempotency_key')) {
      this.db.exec('ALTER TABLE bus_messages ADD COLUMN idempotency_key TEXT');
    }
    const sessionColumns = this.db.prepare('PRAGMA table_info(message_sessions)').all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === 'transport_chat_id')) {
      this.db.exec('ALTER TABLE message_sessions ADD COLUMN transport_chat_id TEXT');
    }
    if (!sessionColumns.some((column) => column.name === 'transport_platform')) {
      this.db.exec('ALTER TABLE message_sessions ADD COLUMN transport_platform TEXT');
    }
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS bus_messages_idempotency_idx ON bus_messages(sender_agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL',
    );
  }

  getSession(id: string): MessageSession | null {
    const row = this.db.prepare('SELECT * FROM message_sessions WHERE id = ?').get(id) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  findSessionByRoom(agentId: string, roomId: string): MessageSession | null {
    const row = this.db
      .prepare('SELECT * FROM message_sessions WHERE agent_id = ? AND room_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(agentId, roomId) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(
    agentId: string,
    options: { limit?: number; offset?: number } = {},
  ): { sessions: MessageSession[]; total: number } {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM message_sessions WHERE agent_id = ?').get(agentId) as { n: number })
        .n,
    );
    const rows = this.db
      .prepare('SELECT * FROM message_sessions WHERE agent_id = ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?')
      .all(agentId, limit, offset) as RawSession[];
    return { sessions: rows.map(mapSession), total };
  }

  ensureSession(input: EnsureSessionInput): MessageSession {
    const id = input.id?.trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = this.getSession(id);
    if (existing && existing.agentId !== input.agentId) throw new Error('session_agent_mismatch');
    if (existing) {
      this.db
        .prepare(
          `UPDATE message_sessions SET agent_name = ?, provider = COALESCE(?, provider),
        provider_session_id = COALESCE(?, provider_session_id), status = COALESCE(?, status),
        room_id = COALESCE(?, room_id), transport_chat_id = COALESCE(?, transport_chat_id),
        transport_platform = COALESCE(?, transport_platform), title = COALESCE(?, title),
        updated_at = ?, last_seen_at = ? WHERE id = ?`,
        )
        .run(
          input.agentName,
          input.provider ?? null,
          input.providerSessionId ?? null,
          input.status ?? null,
          input.roomId ?? null,
          input.transportChatId ?? null,
          input.transportPlatform ?? null,
          input.title ?? null,
          now,
          now,
          id,
        );
      return this.getSession(id)!;
    }
    this.db
      .prepare(
        `INSERT INTO message_sessions
      (id, agent_id, agent_name, provider, provider_session_id, status, room_id,
       transport_chat_id, transport_platform, title, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.agentName,
        input.provider ?? null,
        input.providerSessionId ?? null,
        input.status ?? 'provisioning',
        input.roomId ?? null,
        input.transportChatId ?? null,
        input.transportPlatform ?? null,
        input.title ?? null,
        now,
        now,
        now,
      );
    this.logger.info({ sessionId: id, agentId: input.agentId }, 'message session registered');
    return this.getSession(id)!;
  }

  touchSession(id: string, status?: MessageSessionStatus, providerSessionId?: string): MessageSession | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE message_sessions SET status = COALESCE(?, status),
      provider_session_id = COALESCE(?, provider_session_id), updated_at = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(status ?? null, providerSessionId ?? null, now, now, id);
    return this.getSession(id);
  }

  addMessage(
    input: Omit<MessageRecord, 'id' | 'createdAt' | 'status'> & { id?: string; idempotencyKey?: string },
  ): MessageRecord {
    const id = input.id?.trim() || crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bus_messages
      (id, agent_id, session_id, sender_agent_id, sender_session_id, text, reply_to, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.agentId,
        input.sessionId,
        input.senderAgentId,
        input.senderSessionId ?? null,
        input.text,
        input.replyTo ?? null,
        input.idempotencyKey ?? null,
        createdAt,
      );
    return this.getMessage(id)!;
  }

  getByIdempotency(senderAgentId: string, key: string): MessageRecord | null {
    const row = this.db
      .prepare('SELECT id FROM bus_messages WHERE sender_agent_id = ? AND idempotency_key = ?')
      .get(senderAgentId, key) as { id: string } | undefined;
    return row ? this.getMessage(row.id) : null;
  }

  getMessage(id: string): MessageRecord | null {
    const row = this.db.prepare('SELECT * FROM bus_messages WHERE id = ?').get(id) as RawMessage | undefined;
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      senderAgentId: row.sender_agent_id,
      senderSessionId: row.sender_session_id || undefined,
      text: row.text,
      replyTo: row.reply_to || undefined,
      createdAt: row.created_at,
      status: row.status === 'acked' ? 'acked' : 'pending',
    };
  }

  ackMessage(id: string): MessageRecord | null {
    this.db.prepare("UPDATE bus_messages SET status = 'acked' WHERE id = ?").run(id);
    return this.getMessage(id);
  }
}

interface RawSession {
  id: string;
  agent_id: string;
  agent_name: string;
  provider: string | null;
  provider_session_id: string | null;
  status: MessageSessionStatus;
  room_id: string | null;
  transport_chat_id: string | null;
  transport_platform: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}
interface RawMessage {
  id: string;
  agent_id: string;
  session_id: string;
  sender_agent_id: string;
  sender_session_id: string | null;
  text: string;
  reply_to: string | null;
  status: string;
  created_at: string;
}
function mapSession(row: RawSession): MessageSession {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    provider: row.provider || undefined,
    providerSessionId: row.provider_session_id || undefined,
    status: row.status,
    roomId: row.room_id || undefined,
    transportChatId: row.transport_chat_id || undefined,
    transportPlatform: row.transport_platform || undefined,
    title: row.title || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at || undefined,
  };
}
