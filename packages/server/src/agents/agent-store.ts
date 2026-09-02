import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export interface AgentRecord {
  id: string;
  botName: string;
  url: string;
  description: string;
  visible: boolean;
  /**
   * When true, the CLI defaults this bot's `metabot memory create/mkdir`
   * writes to `/shared/<botName>/...` instead of `/users/<botName>/...`.
   * Bot-level opt-in mirror of `bots.json` `visible` — switches the *default*
   * write target only; existing private docs stay private, and explicit
   * `--path` / `--folder` still wins. ACL itself is unchanged (path-based).
   */
  memoryPublic: boolean;
  ownerCredentialId: string;
  /**
   * Snapshot of the owning credential's `ownerName` at register time. Used by
   * `listAgents` to keep the owner's other-machine credentials seeing their
   * own `visible:false` bots — bot-level `visible` is a public-facing flag,
   * not a self-isolation flag. Empty string for legacy rows backfilled
   * against a now-revoked credential; the owner-bypass treats empty as
   * "no match" so legacy state can't grant accidental access.
   */
  ownerName: string;
  /**
   * Per-user allowlist: when `visible=false`, these named owners can still
   * see the bot via `listAgents`. Stored as a JSON array of `ownerName`
   * strings. Empty array (the default) means only the owner sees a hidden
   * bot. Ignored when `visible=true` (a public bot is public to all).
   */
  visibleToOwners: string[];
  registeredAt: string;
  lastSeenAt: string;
}

export interface RegisterInput {
  botName: string;
  url: string;
  description?: string;
  visible?: boolean;
  memoryPublic?: boolean;
  ownerCredentialId: string;
  /**
   * Snapshot of the caller's `cred.ownerName`. Optional in the unit-test
   * surface (some legacy specs construct an AgentStore without a credentials
   * table); defaults to `''`. The owner-bypass in `listAgents` treats empty
   * as "no match", so an unset value never grants accidental cross-cred
   * access.
   */
  ownerName?: string;
}

export interface ListOptions {
  includeHidden?: boolean;
  now?: number;
  ttlMs?: number;
}

export class NameSquatError extends Error {
  constructor(botName: string) {
    super(`agent name '${botName}' is already registered by a different credential`);
    this.name = 'NameSquatError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(botName: string) {
    super(`agent '${botName}' not registered`);
    this.name = 'AgentNotFoundError';
  }
}

const DEFAULT_TTL_MS = 180_000;
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class AgentStore {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initSchema();
  }

  private initSchema(): void {
    // `talk_secret` is a legacy column from the pre-token-auth era. It is
    // retained nullable so existing rows remain readable; it is never written
    // by new code and never returned in API responses. See
    // [[decision-agent-bus-token-auth]] for why it was removed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id                  TEXT PRIMARY KEY,
        bot_name            TEXT NOT NULL UNIQUE,
        url                 TEXT NOT NULL,
        talk_secret         TEXT,
        visible             INTEGER NOT NULL DEFAULT 1,
        owner_credential_id TEXT NOT NULL,
        registered_at       TEXT NOT NULL,
        last_seen_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agents_visible_idx   ON agents(visible);
      CREATE INDEX IF NOT EXISTS agents_last_seen_idx ON agents(last_seen_at);
    `);

    // Idempotent migration for `memory_public` (added 2026-05-23). `CREATE
    // TABLE IF NOT EXISTS` does NOT add columns to pre-existing rows, so
    // we ADD COLUMN manually and swallow the error if the column already
    // exists. See [[bug_central_db_schema_drift_talk_secret]].
    const cols = this.db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'memory_public')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN memory_public INTEGER NOT NULL DEFAULT 1`);
    }

    // Idempotent migration for `owner_name` (added 2026-05-25). Backfill from
    // `credentials.owner_name` so existing rows immediately participate in
    // the user-level owner-bypass; revoked-credential rows keep empty string
    // and stay locked to public-visibility-only behavior.
    if (!cols.some((c) => c.name === 'owner_name')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN owner_name TEXT NOT NULL DEFAULT ''`);
      const hasCredentials = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credentials'")
        .get();
      if (hasCredentials) {
        this.db.exec(`
          UPDATE agents
             SET owner_name = COALESCE(
               (SELECT owner_name FROM credentials WHERE credentials.id = agents.owner_credential_id),
               ''
             )
        `);
      }
    }

    // Idempotent migration for `visible_to_owners` (added 2026-05-25). JSON
    // array of `ownerName`s that can see this bot even when `visible=0`.
    // Default `[]` keeps every existing row behaving identically to the
    // bot-level visibility model.
    if (!cols.some((c) => c.name === 'visible_to_owners')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN visible_to_owners TEXT NOT NULL DEFAULT '[]'`);
    }

    // Idempotent migration for `description` (added 2026-07-07). This is a
    // user-facing purpose string surfaced in the Agents UI and populated from
    // bots.json or CLI registration. Empty string preserves legacy rows.
    if (!cols.some((c) => c.name === 'description')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
    }
  }

  register(input: RegisterInput): AgentRecord {
    const now = new Date().toISOString();
    const visible = input.visible !== false;

    const existing = this.db
      .prepare('SELECT id, owner_credential_id, owner_name, memory_public FROM agents WHERE bot_name = ?')
      .get(input.botName) as
      | { id: string; owner_credential_id: string; owner_name: string | null; memory_public: 0 | 1 }
      | undefined;

    if (existing) {
      const sameCredential = existing.owner_credential_id === input.ownerCredentialId;
      const sameOwner = !!existing.owner_name && existing.owner_name === input.ownerName;
      if (!sameCredential && !sameOwner) {
        throw new NameSquatError(input.botName);
      }
      // memoryPublic only changes if the caller passed it explicitly — this
      // lets a bot toggle it at runtime via `metabot memory visibility` and
      // not have the next bridge re-register clobber the choice (bots.json
      // doesn't carry it unless the user wants it baked in).
      const memoryPublic =
        input.memoryPublic === undefined ? existing.memory_public === 1 : input.memoryPublic === true;
      // ownerName re-sync on every register so a credential rotation that
      // preserves ownerCredentialId but changes ownerName keeps the row
      // accurate. Owner-bypass reads owner_name directly.
      this.db
        .prepare(
          `
        UPDATE agents SET
          url = ?, description = ?, visible = ?, memory_public = ?,
          owner_credential_id = ?, owner_name = ?, last_seen_at = ?
        WHERE bot_name = ?
      `,
        )
        .run(
          input.url,
          input.description ?? '',
          visible ? 1 : 0,
          memoryPublic ? 1 : 0,
          input.ownerCredentialId,
          input.ownerName ?? '',
          now,
          input.botName,
        );
      this.logger.info({ botName: input.botName }, 'agent re-registered');
      return this.getByName(input.botName)!;
    }

    const id = crypto.randomUUID();
    const memoryPublic = input.memoryPublic !== false;
    this.db
      .prepare(
        `
      INSERT INTO agents (id, bot_name, url, talk_secret, visible, memory_public,
        owner_credential_id, owner_name, description, registered_at, last_seen_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.botName,
        input.url,
        visible ? 1 : 0,
        memoryPublic ? 1 : 0,
        input.ownerCredentialId,
        input.ownerName ?? '',
        input.description ?? '',
        now,
        now,
      );
    this.logger.info({ botName: input.botName, id }, 'agent registered');
    return this.getByName(input.botName)!;
  }

  heartbeat(botName: string, ownerCredentialId: string): string {
    const existing = this.db.prepare('SELECT owner_credential_id FROM agents WHERE bot_name = ?').get(botName) as
      | { owner_credential_id: string }
      | undefined;
    if (!existing) throw new AgentNotFoundError(botName);
    if (existing.owner_credential_id !== ownerCredentialId) {
      throw new NameSquatError(botName);
    }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE bot_name = ?').run(now, botName);
    return now;
  }

  /**
   * Batch heartbeat — bumps last_seen_at on every botName owned by
   * `ownerCredentialId`. Names not owned by the caller (or not registered)
   * are silently skipped; the returned map only contains the bumped rows.
   * Used by the bridge to refresh all its visible bots in one RPC.
   */
  heartbeatMany(botNames: string[], ownerCredentialId: string): Record<string, string> {
    if (!botNames.length) return {};
    const now = new Date().toISOString();
    const owned = new Set(
      (
        this.db
          .prepare(
            `SELECT bot_name FROM agents WHERE owner_credential_id = ? AND bot_name IN (${botNames.map(() => '?').join(',')})`,
          )
          .all(ownerCredentialId, ...botNames) as Array<{ bot_name: string }>
      ).map((r) => r.bot_name),
    );
    if (!owned.size) return {};
    const update = this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE bot_name = ?');
    const result: Record<string, string> = {};
    for (const name of botNames) {
      if (!owned.has(name)) continue;
      update.run(now, name);
      result[name] = now;
    }
    return result;
  }

  /** Returns all agent records owned by the given credential (any visibility). */
  listOwnedBy(ownerCredentialId: string): AgentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agents WHERE owner_credential_id = ?')
      .all(ownerCredentialId) as RawAgentRow[];
    return rows.map(rowToRecord);
  }

  getByName(botName: string): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE bot_name = ?').get(botName) as RawAgentRow | undefined;
    if (!row) return undefined;
    return rowToRecord(row);
  }

  getById(id: string): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as RawAgentRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  search(term?: string, username?: string): AgentRecord[] {
    const q = (term || '').trim().toLowerCase();
    const user = (username || '').trim().toLowerCase();
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY last_seen_at DESC').all() as RawAgentRow[];
    return rows.map(rowToRecord).filter((a) => {
      const text = `${a.botName} ${a.description} ${a.ownerName}`.toLowerCase();
      return (
        (!q || text.includes(q)) &&
        (!user || a.ownerName.toLowerCase() === user || a.ownerName.toLowerCase().includes(user))
      );
    });
  }

  list(options: ListOptions = {}): AgentRecord[] {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const now = options.now ?? Date.now();
    const includeHidden = options.includeHidden === true;

    const baseSql = includeHidden ? 'SELECT * FROM agents' : 'SELECT * FROM agents WHERE visible = 1';
    const rows = this.db.prepare(`${baseSql} ORDER BY last_seen_at DESC`).all() as RawAgentRow[];

    const fresh: AgentRecord[] = [];
    for (const row of rows) {
      const lastSeenMs = Date.parse(row.last_seen_at);
      if (Number.isFinite(lastSeenMs) && now - lastSeenMs > ttlMs) continue;
      fresh.push(rowToRecord(row));
    }
    return fresh;
  }

  setVisibility(botName: string, visible: boolean): AgentRecord {
    const result = this.db.prepare('UPDATE agents SET visible = ? WHERE bot_name = ?').run(visible ? 1 : 0, botName);
    if (result.changes === 0) throw new AgentNotFoundError(botName);
    return this.getByName(botName)!;
  }

  setMemoryPublic(botName: string, memoryPublic: boolean): AgentRecord {
    const result = this.db
      .prepare('UPDATE agents SET memory_public = ? WHERE bot_name = ?')
      .run(memoryPublic ? 1 : 0, botName);
    if (result.changes === 0) throw new AgentNotFoundError(botName);
    return this.getByName(botName)!;
  }

  /**
   * Replace the allowlist with `owners`. Caller is responsible for filtering
   * out empty strings and de-duping if they care — store accepts the array
   * verbatim. Returns the post-update record.
   */
  setVisibleToOwners(botName: string, owners: string[]): AgentRecord {
    const result = this.db
      .prepare('UPDATE agents SET visible_to_owners = ? WHERE bot_name = ?')
      .run(JSON.stringify(owners), botName);
    if (result.changes === 0) throw new AgentNotFoundError(botName);
    return this.getByName(botName)!;
  }

  remove(botName: string): boolean {
    const result = this.db.prepare('DELETE FROM agents WHERE bot_name = ?').run(botName);
    if (result.changes > 0) {
      this.logger.info({ botName }, 'agent removed');
      return true;
    }
    return false;
  }

  purgeStale(now: number = Date.now(), maxAgeMs: number = STALE_MAX_AGE_MS): number {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const result = this.db.prepare('DELETE FROM agents WHERE last_seen_at < ?').run(cutoff);
    if (result.changes > 0) {
      this.logger.info({ removed: result.changes, cutoff }, 'agents purged');
    }
    return result.changes as number;
  }
}

interface RawAgentRow {
  id: string;
  bot_name: string;
  url: string;
  description: string | null;
  talk_secret: string | null;
  visible: 0 | 1;
  memory_public: 0 | 1;
  owner_credential_id: string;
  owner_name: string | null;
  visible_to_owners: string | null;
  registered_at: string;
  last_seen_at: string;
}

function rowToRecord(row: RawAgentRow): AgentRecord {
  return {
    id: row.id,
    botName: row.bot_name,
    url: row.url,
    description: row.description || '',
    visible: row.visible === 1,
    memoryPublic: row.memory_public === 1,
    ownerCredentialId: row.owner_credential_id,
    ownerName: row.owner_name || '',
    visibleToOwners: parseOwnerList(row.visible_to_owners),
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
  };
}

function parseOwnerList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
