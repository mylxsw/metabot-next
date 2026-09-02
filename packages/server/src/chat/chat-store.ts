import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type {
  ChatConversation,
  ChatConversationKind,
  ChatConversationSummary,
  ChatMessage,
  ChatMessageKind,
  ChatParticipant,
  ChatParticipantCandidate,
  ChatParticipantKind,
  ChatReadState,
  ChatRun,
  ChatRunEvent,
  ChatRunEventKind,
  ChatRunPresentation,
  ChatRunStatus,
  ChatFile,
} from './chat-types.js';

// Default under the user's home; override with METABOT_CORE_CHAT_FILE_DIR.
export const DEFAULT_CHAT_FILE_STORAGE_ROOT = path.join(os.homedir(), '.metabot-core', 'chat-files');

export function resolveChatFilePath(
  storageKey: string,
  root = process.env.METABOT_CORE_CHAT_FILE_DIR || DEFAULT_CHAT_FILE_STORAGE_ROOT,
): string {
  const safeKey = normalizeStorageKey(storageKey);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safeKey);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw Object.assign(new Error('bad_storage_key'), { statusCode: 400 });
  }
  return resolved;
}

export class ChatNotFoundError extends Error {
  constructor(id: string) {
    super(`chat conversation '${id}' not found`);
    this.name = 'ChatNotFoundError';
  }
}

export class ChatForbiddenError extends Error {
  constructor() {
    super('chat_participant_required');
    this.name = 'ChatForbiddenError';
  }
}

export interface CreateConversationInput {
  kind: ChatConversationKind;
  title?: string;
  createdBy: string;
  participants: Array<{
    kind: ChatParticipantKind;
    ref: string;
    displayName?: string;
  }>;
}

export interface AppendMessageInput {
  conversationId: string;
  kind: ChatMessageKind;
  senderKind: ChatParticipantKind;
  senderRef: string;
  senderDisplayName?: string;
  content: string;
  mentionedAgentRefs?: string[];
  runId?: string | null;
  replyTo?: string | null;
  senderSessionId?: string | null;
}

export interface CreateRunInput {
  conversationId: string;
  triggerMessageId: string;
  targetAgentRef: string;
  engine?: string | null;
  model?: string | null;
  idempotencyOwner?: string | null;
  idempotencyKey?: string | null;
  presentation?: ChatRunPresentation | null;
}

export interface AppendRunEventInput {
  runId: string;
  seq: number;
  kind: ChatRunEventKind;
  payload: Record<string, unknown>;
}

export interface CreateFileInput {
  conversationId: string;
  messageId?: string | null;
  runId?: string | null;
  name: string;
  mimeType: string;
  sizeBytes?: number | null;
  storageKey?: string;
  createdBy: string;
}

interface RawConversationRow {
  id: string;
  kind: ChatConversationKind;
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

interface RawParticipantRow {
  conversation_id: string;
  kind: ChatParticipantKind;
  ref: string;
  display_name: string;
  added_by: string;
  added_at: string;
}

interface RawMessageRow {
  id: string;
  conversation_id: string;
  kind: ChatMessageKind;
  sender_kind: ChatParticipantKind;
  sender_ref: string;
  sender_display_name: string;
  content: string;
  mentioned_agent_refs: string;
  run_id: string | null;
  reply_to?: string | null;
  sender_session_id?: string | null;
  created_at: string;
}

interface RawReadStateRow {
  conversation_id: string;
  user_ref: string;
  last_read_message_id: string | null;
  last_read_at: string;
}

interface RawRunRow {
  id: string;
  conversation_id: string;
  trigger_message_id: string;
  target_agent_ref: string;
  engine: string | null;
  model: string | null;
  status: ChatRunStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
  final_message_id: string | null;
  idempotency_owner?: string | null;
  idempotency_key?: string | null;
  presentation_json?: string | null;
}

interface RawRunEventRow {
  id: string;
  run_id: string;
  seq: number;
  kind: ChatRunEventKind;
  payload_json: string;
  created_at: string;
}

interface RawFileRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  run_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number | null;
  storage_key: string;
  created_by: string;
  created_at: string;
}

export class ChatStore {
  private db: Database.Database;
  private logger: Logger;
  /** In-process fan-out for chat SSE subscribers. */
  readonly events = new EventEmitter();

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.events.setMaxListeners(0);
    this.initSchema();
  }

  private emitLive(event: import('./chat-types.js').ChatLiveEvent): void {
    try {
      this.events.emit('chat', event);
    } catch (err) {
      this.logger.warn({ err, type: event.type, conversationId: event.conversationId }, 'chat live event listener threw');
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
        title           TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_message_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_participants (
        conversation_id TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
        ref             TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        added_by        TEXT NOT NULL,
        added_at        TEXT NOT NULL,
        PRIMARY KEY (conversation_id, kind, ref),
        FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id                   TEXT PRIMARY KEY,
        conversation_id      TEXT NOT NULL,
        kind                 TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'system')),
        sender_kind          TEXT NOT NULL CHECK (sender_kind IN ('user', 'agent')),
        sender_ref           TEXT NOT NULL,
        sender_display_name  TEXT NOT NULL,
        content              TEXT NOT NULL,
      mentioned_agent_refs TEXT NOT NULL DEFAULT '[]',
      run_id               TEXT,
        reply_to             TEXT,
        sender_session_id    TEXT,
        created_at           TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_read_state (
        conversation_id      TEXT NOT NULL,
        user_ref             TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_at         TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_ref),
        FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_runs (
        id                 TEXT PRIMARY KEY,
        conversation_id    TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        target_agent_ref   TEXT NOT NULL,
        engine             TEXT,
        model              TEXT,
        idempotency_owner  TEXT,
        idempotency_key    TEXT,
        presentation_json  TEXT,
        status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_user', 'completed', 'failed', 'canceled')),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        completed_at       TEXT,
        error              TEXT,
        final_message_id   TEXT,
        FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (trigger_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (final_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS chat_run_events (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('state', 'complete', 'question', 'file', 'log', 'error')),
        payload_json TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_files (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id      TEXT,
        run_id          TEXT,
        name            TEXT NOT NULL,
        mime_type       TEXT NOT NULL,
        size_bytes      INTEGER,
        storage_key     TEXT NOT NULL UNIQUE,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE SET NULL,
        FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS chat_participants_ref_idx
        ON chat_participants(kind, ref, conversation_id);
      CREATE INDEX IF NOT EXISTS chat_messages_conversation_created_idx
        ON chat_messages(conversation_id, created_at, id);
      CREATE INDEX IF NOT EXISTS chat_messages_run_idx
        ON chat_messages(run_id);
      CREATE INDEX IF NOT EXISTS chat_runs_conversation_status_idx
        ON chat_runs(conversation_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS chat_runs_trigger_idx
        ON chat_runs(trigger_message_id);
      CREATE INDEX IF NOT EXISTS chat_run_events_run_seq_idx
        ON chat_run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS chat_files_conversation_created_idx
        ON chat_files(conversation_id, created_at);
    `);
    this.ensureColumn('chat_runs', 'engine', 'TEXT');
    this.ensureColumn('chat_runs', 'model', 'TEXT');
    this.ensureColumn('chat_runs', 'idempotency_owner', 'TEXT');
    this.ensureColumn('chat_runs', 'idempotency_key', 'TEXT');
    this.ensureColumn('chat_runs', 'presentation_json', 'TEXT');
    this.ensureColumn('chat_messages', 'reply_to', 'TEXT');
    this.ensureColumn('chat_messages', 'sender_session_id', 'TEXT');
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS chat_runs_idempotency_idx ON chat_runs(idempotency_owner, idempotency_key) WHERE idempotency_key IS NOT NULL',
    );
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }

  createConversation(input: CreateConversationInput): ChatConversationSummary {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const participants = normalizeParticipants([
      { kind: 'user', ref: input.createdBy, displayName: input.createdBy },
      ...input.participants,
    ]);
    if (input.kind === 'dm' && participants.length !== 2) {
      throw Object.assign(new Error('dm_participant_count_invalid'), { statusCode: 400 });
    }
    const title = normalizeTitle(input.title, input.kind, participants, input.createdBy);

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO chat_conversations (id, kind, title, created_by, created_at, updated_at, last_message_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `,
        )
        .run(id, input.kind, title, input.createdBy, now, now);
      const stmt = this.db.prepare(`
        INSERT INTO chat_participants (conversation_id, kind, ref, display_name, added_by, added_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const p of participants) {
        stmt.run(id, p.kind, p.ref, p.displayName || p.ref, input.createdBy, now);
      }
      this.markReadUnchecked(id, input.createdBy, null, now);
    });
    insert();
    this.logger.info({ conversationId: id, kind: input.kind }, 'chat conversation created');
    return this.getConversationForUser(id, input.createdBy);
  }

  findAgentDm(userRef: string, agentRef: string): ChatConversationSummary | null {
    const row = this.db
      .prepare(
        `
      SELECT c.*
        FROM chat_conversations c
        JOIN chat_participants u
          ON u.conversation_id = c.id AND u.kind = 'user' AND u.ref = ?
        JOIN chat_participants a
          ON a.conversation_id = c.id AND a.kind = 'agent' AND a.ref = ?
       WHERE c.kind = 'dm'
         AND (SELECT COUNT(*) FROM chat_participants p WHERE p.conversation_id = c.id) = 2
       ORDER BY c.updated_at DESC
       LIMIT 1
    `,
      )
      .get(userRef, agentRef) as RawConversationRow | undefined;
    if (!row) return null;
    return this.summaryFromConversation(row, userRef);
  }

  findOrCreateAgentDm(input: {
    userRef: string;
    agentRef: string;
    agentDisplayName?: string;
  }): ChatConversationSummary {
    const existing = this.findAgentDm(input.userRef, input.agentRef);
    if (existing) return existing;
    return this.createConversation({
      kind: 'dm',
      title: input.agentDisplayName || input.agentRef,
      createdBy: input.userRef,
      participants: [{ kind: 'agent', ref: input.agentRef, displayName: input.agentDisplayName || input.agentRef }],
    });
  }

  findUserDm(userRef: string, otherUserRef: string): ChatConversationSummary | null {
    const normalizedUser = normalizeRef('user', userRef);
    const normalizedOther = normalizeRef('user', otherUserRef);
    const row = this.db
      .prepare(
        `
      SELECT c.*
        FROM chat_conversations c
        JOIN chat_participants u
          ON u.conversation_id = c.id AND u.kind = 'user' AND u.ref = ?
        JOIN chat_participants o
          ON o.conversation_id = c.id AND o.kind = 'user' AND o.ref = ?
       WHERE c.kind = 'dm'
         AND (SELECT COUNT(*) FROM chat_participants p WHERE p.conversation_id = c.id) = 2
       ORDER BY c.updated_at DESC
       LIMIT 1
    `,
      )
      .get(normalizedUser, normalizedOther) as RawConversationRow | undefined;
    if (!row) return null;
    return this.summaryFromConversation(row, normalizedUser);
  }

  findOrCreateUserDm(input: {
    userRef: string;
    otherUserRef: string;
    otherDisplayName?: string;
  }): ChatConversationSummary {
    const userRef = normalizeRef('user', input.userRef);
    const otherUserRef = normalizeRef('user', input.otherUserRef);
    if (userRef === otherUserRef) {
      throw Object.assign(new Error('self_dm_not_allowed'), { statusCode: 400 });
    }
    const existing = this.findUserDm(userRef, otherUserRef);
    if (existing) return existing;
    return this.createConversation({
      kind: 'dm',
      title: input.otherDisplayName || otherUserRef,
      createdBy: userRef,
      participants: [{ kind: 'user', ref: otherUserRef, displayName: input.otherDisplayName || otherUserRef }],
    });
  }

  searchKnownUsers(query: string, limit = 20): ChatParticipantCandidate[] {
    const q = normalizeRef('user', query);
    const capped = Math.min(Math.max(limit, 1), 50);
    if (!q) return [];
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const rows = this.db
      .prepare(
        `
      SELECT ref, MAX(display_name) AS display_name
        FROM chat_participants
       WHERE kind = 'user'
         AND (ref LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       GROUP BY ref
       ORDER BY ref ASC
       LIMIT ?
    `,
      )
      .all(like, like, capped) as Array<{ ref: string; display_name: string | null }>;
    return rows.map((row) => ({
      kind: 'user',
      ref: row.ref,
      displayName: row.display_name || row.ref,
      source: 'known',
    }));
  }

  getConversationForUser(id: string, userRef: string): ChatConversationSummary {
    this.assertParticipant(id, 'user', userRef);
    const row = this.db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as
      | RawConversationRow
      | undefined;
    if (!row) throw new ChatNotFoundError(id);
    return this.summaryFromConversation(row, userRef);
  }

  listConversationsForUser(userRef: string): ChatConversationSummary[] {
    const rows = this.db
      .prepare(
        `
      SELECT c.*
        FROM chat_conversations c
        JOIN chat_participants p ON p.conversation_id = c.id
       WHERE p.kind = 'user' AND p.ref = ?
       ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC, c.created_at DESC
    `,
      )
      .all(userRef) as RawConversationRow[];
    return rows.map((row) => this.summaryFromConversation(row, userRef));
  }

  addParticipant(
    conversationId: string,
    actorUserRef: string,
    participant: { kind: ChatParticipantKind; ref: string; displayName?: string },
  ): ChatParticipant {
    this.assertParticipant(conversationId, 'user', actorUserRef);
    const conv = this.db.prepare('SELECT kind, created_by FROM chat_conversations WHERE id = ?').get(conversationId) as
      | { kind: ChatConversationKind; created_by: string }
      | undefined;
    if (!conv) throw new ChatNotFoundError(conversationId);
    if (conv.created_by !== actorUserRef) {
      throw Object.assign(new Error('chat_owner_required'), { statusCode: 403 });
    }
    if (conv.kind === 'dm') {
      throw Object.assign(new Error('dm_participants_immutable'), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO chat_participants (conversation_id, kind, ref, display_name, added_by, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        conversationId,
        participant.kind,
        normalizeRef(participant.kind, participant.ref),
        participant.displayName || normalizeRef(participant.kind, participant.ref),
        actorUserRef,
        now,
      );
    this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    return this.getParticipant(conversationId, participant.kind, participant.ref)!;
  }

  listParticipants(conversationId: string, userRef: string): ChatParticipant[] {
    this.assertParticipant(conversationId, 'user', userRef);
    return this.listParticipantsUnchecked(conversationId);
  }

  appendMessage(input: AppendMessageInput): ChatMessage {
    const content = input.content.trim();
    if (!content) {
      throw Object.assign(new Error('content_required'), { statusCode: 400 });
    }
    this.assertParticipant(input.conversationId, input.senderKind, input.senderRef);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const mentioned = dedupeStrings(input.mentionedAgentRefs || []);
    this.db
      .prepare(
        `
      INSERT INTO chat_messages (
        id, conversation_id, kind, sender_kind, sender_ref, sender_display_name,
        content, mentioned_agent_refs, run_id, reply_to, sender_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.conversationId,
        input.kind,
        input.senderKind,
        input.senderRef,
        input.senderDisplayName || input.senderRef,
        content,
        JSON.stringify(mentioned),
        input.runId || null,
        input.replyTo || null,
        input.senderSessionId || null,
        now,
      );
    this.db
      .prepare(
        `
      UPDATE chat_conversations
         SET updated_at = ?, last_message_at = ?
       WHERE id = ?
    `,
      )
      .run(now, now, input.conversationId);
    if (input.senderKind === 'user') {
      this.markReadUnchecked(input.conversationId, input.senderRef, id, now);
    }
    const message = this.getMessage(id)!;
    this.emitLive({ type: 'message.created', conversationId: input.conversationId, message });
    return message;
  }

  listMessages(
    conversationId: string,
    userRef: string,
    options: { limit?: number; before?: string } = {},
  ): ChatMessage[] {
    this.assertParticipant(conversationId, 'user', userRef);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const before = options.before;
    const rows = before
      ? (this.db
          .prepare(
            `
          SELECT * FROM chat_messages
           WHERE conversation_id = ? AND rowid < (
             SELECT rowid FROM chat_messages WHERE id = ? AND conversation_id = ?
           )
           ORDER BY rowid DESC
           LIMIT ?
        `,
          )
          .all(conversationId, before, conversationId, limit) as RawMessageRow[])
      : (this.db
          .prepare(
            `
          SELECT * FROM chat_messages
           WHERE conversation_id = ?
           ORDER BY rowid DESC
           LIMIT ?
        `,
          )
          .all(conversationId, limit) as RawMessageRow[]);
    return rows.map(rowToMessage).reverse();
  }

  markRead(conversationId: string, userRef: string, messageId: string | null): ChatReadState {
    this.assertParticipant(conversationId, 'user', userRef);
    if (messageId !== null) {
      const row = this.db
        .prepare('SELECT id FROM chat_messages WHERE conversation_id = ? AND id = ?')
        .get(conversationId, messageId);
      if (!row) throw Object.assign(new Error('message_not_found'), { statusCode: 404 });
    }
    const now = new Date().toISOString();
    this.markReadUnchecked(conversationId, userRef, messageId, now);
    return this.getReadState(conversationId, userRef)!;
  }

  createRun(input: CreateRunInput): ChatRun {
    this.assertParticipant(input.conversationId, 'agent', input.targetAgentRef);
    const trigger = this.getMessage(input.triggerMessageId);
    if (!trigger || trigger.conversationId !== input.conversationId) {
      throw Object.assign(new Error('trigger_message_not_found'), { statusCode: 404 });
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO chat_runs (
        id, conversation_id, trigger_message_id, target_agent_ref, engine, model,
        idempotency_owner, idempotency_key, presentation_json, status,
        created_at, updated_at, completed_at, error, final_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL)
    `,
      )
      .run(
        id,
        input.conversationId,
        input.triggerMessageId,
        input.targetAgentRef,
        cleanOptional(input.engine),
        cleanOptional(input.model),
        cleanOptional(input.idempotencyOwner),
        cleanOptional(input.idempotencyKey),
        input.presentation ? JSON.stringify(input.presentation) : null,
        now,
        now,
      );
    const run = this.getRun(id)!;
    this.emitLive({ type: 'run.updated', conversationId: input.conversationId, run });
    return run;
  }

  getRunForUser(runId: string, userRef: string): ChatRun {
    const run = this.getRun(runId);
    if (!run) throw Object.assign(new Error('run_not_found'), { statusCode: 404 });
    this.assertParticipant(run.conversationId, 'user', userRef);
    return run;
  }

  getRun(runId: string): ChatRun | null {
    const row = this.db.prepare('SELECT * FROM chat_runs WHERE id = ?').get(runId) as RawRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getRunByIdempotency(owner: string, key: string): ChatRun | null {
    const row = this.db
      .prepare('SELECT * FROM chat_runs WHERE idempotency_owner = ? AND idempotency_key = ?')
      .get(owner, key) as RawRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getRunByTriggerMessageId(messageId: string): ChatRun | null {
    const row = this.db.prepare('SELECT * FROM chat_runs WHERE trigger_message_id = ?').get(messageId) as
      | RawRunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  appendMessageAndCreateRun(
    message: AppendMessageInput,
    run: Omit<CreateRunInput, 'triggerMessageId'>,
  ): { message: ChatMessage; run: ChatRun; idempotentReplay: boolean } {
    if (run.idempotencyOwner && run.idempotencyKey) {
      const prior = this.getRunByIdempotency(run.idempotencyOwner, run.idempotencyKey);
      if (prior) return { message: this.getMessage(prior.triggerMessageId)!, run: prior, idempotentReplay: true };
    }
    const created = this.appendMessage(message);
    try {
      const createdRun = this.createRun({ ...run, triggerMessageId: created.id });
      return { message: created, run: createdRun, idempotentReplay: false };
    } catch (error) {
      // A concurrent retry may win the unique idempotency index between the
      // lookup above and INSERT. Return that canonical run instead of leaking
      // a SQLite constraint error to the caller.
      if (run.idempotencyOwner && run.idempotencyKey) {
        const prior = this.getRunByIdempotency(run.idempotencyOwner, run.idempotencyKey);
        if (prior) return { message: this.getMessage(prior.triggerMessageId)!, run: prior, idempotentReplay: true };
      }
      throw error;
    }
  }

  listRuns(conversationId: string, userRef: string): ChatRun[] {
    this.assertParticipant(conversationId, 'user', userRef);
    const rows = this.db
      .prepare(
        `
      SELECT * FROM chat_runs
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC
    `,
      )
      .all(conversationId) as RawRunRow[];
    return rows.map(rowToRun);
  }

  appendRunEvent(input: AppendRunEventInput): ChatRunEvent {
    if (!Number.isInteger(input.seq) || input.seq < 0) {
      throw Object.assign(new Error('seq_required'), { statusCode: 400 });
    }
    const run = this.getRun(input.runId);
    if (!run) throw Object.assign(new Error('run_not_found'), { statusCode: 404 });

    let inserted = false;
    const tx = this.db.transaction(() => {
      const payloadJson = JSON.stringify(input.payload);
      const existing = this.db
        .prepare('SELECT * FROM chat_run_events WHERE run_id = ? AND seq = ?')
        .get(input.runId, input.seq) as RawRunEventRow | undefined;
      if (existing) {
        if (existing.kind !== input.kind || existing.payload_json !== payloadJson) {
          throw Object.assign(new Error('run_event_seq_conflict'), { statusCode: 409 });
        }
        return rowToRunEvent(existing);
      }
      if (isTerminalRun(run)) {
        throw Object.assign(new Error('run_terminal'), { statusCode: 409 });
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `
        INSERT INTO chat_run_events (id, run_id, seq, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(id, input.runId, input.seq, input.kind, payloadJson, now);
      inserted = true;

      if (input.kind === 'state') {
        this.updateRunStatus(input.runId, payloadStatus(input.payload) || 'running', now);
      } else if (input.kind === 'question') {
        this.updateRunStatus(input.runId, 'waiting_user', now);
      } else if (input.kind === 'error') {
        this.updateRunStatus(
          input.runId,
          payloadStatus(input.payload) === 'canceled' ? 'canceled' : 'failed',
          now,
          payloadError(input.payload),
        );
      } else if (input.kind === 'complete') {
        this.completeRun(run, input.payload, now);
      } else if (input.kind === 'file') {
        this.recordFilesFromPayload(run, input.payload, now);
        this.updateRunStatus(input.runId, run.status === 'queued' ? 'running' : run.status, now);
      }

      const row = this.db.prepare('SELECT * FROM chat_run_events WHERE id = ?').get(id) as RawRunEventRow;
      return rowToRunEvent(row);
    });
    const event = tx();
    const updatedRun = this.getRun(input.runId);
    if (updatedRun && inserted) {
      this.emitLive({ type: 'run.event', conversationId: updatedRun.conversationId, runId: updatedRun.id, event });
      this.emitLive({ type: 'run.updated', conversationId: updatedRun.conversationId, run: updatedRun });
      if (event.kind === 'complete' && updatedRun.finalMessageId) {
        const message = this.getMessage(updatedRun.finalMessageId);
        if (message) this.emitLive({ type: 'message.created', conversationId: updatedRun.conversationId, message });
      }
      if (event.kind === 'file') {
        const rows = this.db.prepare('SELECT * FROM chat_files WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(updatedRun.id) as RawFileRow[];
        for (const row of rows) {
          const file = rowToFile(row);
          this.emitLive({ type: 'file.created', conversationId: updatedRun.conversationId, file });
        }
      }
    }
    return event;
  }

  listRunEventsForUser(runId: string, userRef: string): ChatRunEvent[] {
    const run = this.getRunForUser(runId, userRef);
    const rows = this.db
      .prepare(
        `
      SELECT * FROM chat_run_events
       WHERE run_id = ?
       ORDER BY seq ASC
    `,
      )
      .all(run.id) as RawRunEventRow[];
    return rows.map(rowToRunEvent);
  }

  createFile(input: CreateFileInput): ChatFile {
    this.assertParticipant(input.conversationId, 'user', input.createdBy);
    return this.createFileUnchecked(input, new Date().toISOString());
  }

  listFiles(conversationId: string, userRef: string): ChatFile[] {
    this.assertParticipant(conversationId, 'user', userRef);
    const rows = this.db
      .prepare(
        `
      SELECT * FROM chat_files
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC
    `,
      )
      .all(conversationId) as RawFileRow[];
    return rows.map(rowToFile);
  }

  private updateRunStatus(runId: string, status: ChatRunStatus, updatedAt: string, error?: string | null): void {
    this.db
      .prepare(
        `
      UPDATE chat_runs
         SET status = ?, updated_at = ?, error = COALESCE(?, error)
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')
    `,
      )
      .run(status, updatedAt, error ?? null, runId);
  }

  private completeRun(run: ChatRun, payload: Record<string, unknown>, at: string): void {
    const fresh = this.getRun(run.id);
    if (!fresh || fresh.finalMessageId) return;
    const content = payloadContent(payload);
    if (!content) throw Object.assign(new Error('complete_content_required'), { statusCode: 400 });
    const messageId = crypto.randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO chat_messages (
        id, conversation_id, kind, sender_kind, sender_ref, sender_display_name,
        content, mentioned_agent_refs, run_id, created_at
      ) VALUES (?, ?, 'assistant', 'agent', ?, ?, ?, '[]', ?, ?)
    `,
      )
      .run(messageId, fresh.conversationId, fresh.targetAgentRef, fresh.targetAgentRef, content, fresh.id, at);
    this.db
      .prepare(
        `
      UPDATE chat_runs
         SET status = 'completed', updated_at = ?, completed_at = ?, final_message_id = ?
       WHERE id = ?
    `,
      )
      .run(at, at, messageId, fresh.id);
    this.db
      .prepare(
        `
      UPDATE chat_conversations
         SET updated_at = ?, last_message_at = ?
       WHERE id = ?
    `,
      )
      .run(at, at, fresh.conversationId);
  }

  private recordFilesFromPayload(run: ChatRun, payload: Record<string, unknown>, at: string): void {
    const rawFiles = Array.isArray(payload.files) ? payload.files : [payload];
    for (const raw of rawFiles) {
      if (!raw || typeof raw !== 'object') continue;
      const file = raw as Record<string, unknown>;
      const name = typeof file.name === 'string' ? file.name.trim() : '';
      if (!name) continue;
      const mimeType =
        typeof file.mimeType === 'string'
          ? file.mimeType
          : typeof file.mime_type === 'string'
            ? file.mime_type
            : 'application/octet-stream';
      const sizeBytes =
        typeof file.sizeBytes === 'number'
          ? file.sizeBytes
          : typeof file.size_bytes === 'number'
            ? file.size_bytes
            : null;
      const storageKey = typeof file.storageKey === 'string' ? file.storageKey : undefined;
      this.createFileUnchecked(
        {
          conversationId: run.conversationId,
          runId: run.id,
          name,
          mimeType,
          sizeBytes,
          storageKey,
          createdBy: run.targetAgentRef,
        },
        at,
      );
    }
  }

  private createFileUnchecked(input: CreateFileInput, at: string): ChatFile {
    const storageKey = normalizeStorageKey(input.storageKey);
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO chat_files (
        id, conversation_id, message_id, run_id, name, mime_type,
        size_bytes, storage_key, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.conversationId,
        input.messageId || null,
        input.runId || null,
        input.name.trim(),
        input.mimeType || 'application/octet-stream',
        input.sizeBytes ?? null,
        storageKey,
        input.createdBy,
        at,
      );
    const row = this.db.prepare('SELECT * FROM chat_files WHERE id = ?').get(id) as RawFileRow;
    return rowToFile(row);
  }

  private assertParticipant(conversationId: string, kind: ChatParticipantKind, ref: string): void {
    const exists = this.db
      .prepare(
        `
      SELECT 1 FROM chat_participants
       WHERE conversation_id = ? AND kind = ? AND ref = ?
    `,
      )
      .get(conversationId, kind, ref);
    if (exists) return;
    const conv = this.db.prepare('SELECT 1 FROM chat_conversations WHERE id = ?').get(conversationId);
    if (!conv) throw new ChatNotFoundError(conversationId);
    throw new ChatForbiddenError();
  }

  private getParticipant(conversationId: string, kind: ChatParticipantKind, ref: string): ChatParticipant | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM chat_participants WHERE conversation_id = ? AND kind = ? AND ref = ?
    `,
      )
      .get(conversationId, kind, ref) as RawParticipantRow | undefined;
    return row ? rowToParticipant(row) : null;
  }

  private listParticipantsUnchecked(conversationId: string): ChatParticipant[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM chat_participants WHERE conversation_id = ? ORDER BY kind DESC, added_at ASC
    `,
      )
      .all(conversationId) as RawParticipantRow[];
    return rows.map(rowToParticipant);
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as RawMessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  private getReadState(conversationId: string, userRef: string): ChatReadState | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM chat_read_state WHERE conversation_id = ? AND user_ref = ?
    `,
      )
      .get(conversationId, userRef) as RawReadStateRow | undefined;
    return row ? rowToReadState(row) : null;
  }

  private markReadUnchecked(conversationId: string, userRef: string, messageId: string | null, at: string): void {
    this.db
      .prepare(
        `
      INSERT INTO chat_read_state (conversation_id, user_ref, last_read_message_id, last_read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, user_ref) DO UPDATE SET
        last_read_message_id = excluded.last_read_message_id,
        last_read_at = excluded.last_read_at
    `,
      )
      .run(conversationId, userRef, messageId, at);
  }

  private summaryFromConversation(row: RawConversationRow, userRef: string): ChatConversationSummary {
    const conversation = rowToConversation(row);
    const lastRow = this.db
      .prepare(
        `
      SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1
    `,
      )
      .get(row.id) as RawMessageRow | undefined;
    const read = this.getReadState(row.id, userRef);
    const unreadCount = countUnread(this.db, row.id, read?.lastReadMessageId || null, userRef);
    return {
      ...conversation,
      participants: this.listParticipantsUnchecked(row.id),
      lastMessage: lastRow ? rowToMessage(lastRow) : null,
      unreadCount,
    };
  }
}

function rowToConversation(row: RawConversationRow): ChatConversation {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

function rowToParticipant(row: RawParticipantRow): ChatParticipant {
  return {
    conversationId: row.conversation_id,
    kind: row.kind,
    ref: row.ref,
    displayName: row.display_name,
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

function rowToMessage(row: RawMessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    senderKind: row.sender_kind,
    senderRef: row.sender_ref,
    senderDisplayName: row.sender_display_name,
    content: row.content,
    mentionedAgentRefs: parseStringArray(row.mentioned_agent_refs),
    runId: row.run_id,
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    ...(row.sender_session_id ? { senderSessionId: row.sender_session_id } : {}),
    createdAt: row.created_at,
  };
}

function rowToReadState(row: RawReadStateRow): ChatReadState {
  return {
    conversationId: row.conversation_id,
    userRef: row.user_ref,
    lastReadMessageId: row.last_read_message_id,
    lastReadAt: row.last_read_at,
  };
}

function rowToRun(row: RawRunRow): ChatRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    triggerMessageId: row.trigger_message_id,
    targetAgentRef: row.target_agent_ref,
    engine: row.engine,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error,
    finalMessageId: row.final_message_id,
    idempotencyOwner: row.idempotency_owner || null,
    idempotencyKey: row.idempotency_key || null,
    presentation: row.presentation_json ? (parseObject(row.presentation_json) as unknown as ChatRunPresentation) : null,
  };
}

function cleanOptional(value: string | null | undefined): string | null {
  const clean = typeof value === 'string' ? value.trim() : '';
  return clean || null;
}

function rowToRunEvent(row: RawRunEventRow): ChatRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    payload: parseObject(row.payload_json),
    createdAt: row.created_at,
  };
}

function rowToFile(row: RawFileRow): ChatFile {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    runId: row.run_id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function normalizeParticipants(
  input: Array<{ kind: ChatParticipantKind; ref: string; displayName?: string }>,
): Array<{ kind: ChatParticipantKind; ref: string; displayName: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: ChatParticipantKind; ref: string; displayName: string }> = [];
  for (const raw of input) {
    const ref = raw.ref.trim();
    if (!ref) continue;
    const normalizedRef = normalizeRef(raw.kind, ref);
    const key = `${raw.kind}:${normalizedRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: raw.kind,
      ref: normalizedRef,
      displayName: (raw.displayName || normalizedRef).trim() || normalizedRef,
    });
  }
  return out;
}

function normalizeRef(kind: ChatParticipantKind, ref: string): string {
  const trimmed = ref.trim();
  return kind === 'user' ? trimmed.toLowerCase() : trimmed;
}

function normalizeTitle(
  title: string | undefined,
  kind: ChatConversationKind,
  participants: Array<{ kind: ChatParticipantKind; ref: string; displayName: string }>,
  createdBy: string,
): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, 160);
  const names = participants
    .filter((p) => p.ref !== createdBy)
    .map((p) => p.displayName)
    .slice(0, 4);
  if (names.length) return names.join(', ').slice(0, 160);
  return kind === 'dm' ? 'Direct message' : 'Group chat';
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const v = value.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function payloadStatus(payload: Record<string, unknown>): ChatRunStatus | null {
  const status = payload.status;
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting_user' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled'
  )
    return status;
  return null;
}

function isTerminalRun(run: ChatRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'canceled';
}

function payloadError(payload: Record<string, unknown>): string | null {
  return typeof payload.error === 'string' ? payload.error : null;
}

function payloadContent(payload: Record<string, unknown>): string {
  for (const key of ['content', 'message', 'text', 'finalContent']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeStorageKey(input: string | undefined): string {
  const key = (input || crypto.randomUUID()).trim();
  if (!key || key.includes('..') || key.startsWith('/') || key.includes('\\')) {
    throw Object.assign(new Error('bad_storage_key'), { statusCode: 400 });
  }
  return key;
}

function countUnread(
  db: Database.Database,
  conversationId: string,
  lastReadMessageId: string | null,
  userRef: string,
): number {
  if (!lastReadMessageId) {
    const row = db
      .prepare(
        `
      SELECT COUNT(*) AS count FROM chat_messages
       WHERE conversation_id = ? AND NOT (sender_kind = 'user' AND sender_ref = ?)
    `,
      )
      .get(conversationId, userRef) as { count: number };
    return row.count;
  }
  const row = db
    .prepare(
      `
    SELECT COUNT(*) AS count FROM chat_messages
     WHERE conversation_id = ?
       AND rowid > COALESCE((
         SELECT rowid FROM chat_messages WHERE conversation_id = ? AND id = ?
       ), 0)
       AND NOT (sender_kind = 'user' AND sender_ref = ?)
  `,
    )
    .get(conversationId, conversationId, lastReadMessageId, userRef) as { count: number };
  return row.count;
}
