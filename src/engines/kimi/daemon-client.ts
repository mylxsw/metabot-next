import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ORIGIN = 'http://127.0.0.1:58627';
const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

export function buildKimiServerArgs(port: string): string[] {
  return ['web', '--port', port, '--no-open'];
}

interface KimiEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id?: string;
  details?: unknown;
}

export interface KimiWireUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
}

export type KimiWireMessageContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface KimiWireMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: KimiWireMessageContent[];
  created_at: string;
  prompt_id?: string;
}

export interface KimiWireSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  current_prompt_id?: string;
  last_prompt?: string;
  metadata: { cwd?: string; [key: string]: unknown };
  agent_config: { model?: string; [key: string]: unknown };
  usage: KimiWireUsage;
}

export interface KimiInFlightTool {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  last_progress?: { kind: string; text?: string; percent?: number };
}

export interface KimiPendingQuestion {
  question_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    body?: string;
    options: Array<{ id: string; label: string; description?: string }>;
    multi_select?: boolean;
    allow_other?: boolean;
  }>;
}

export interface KimiPendingApproval {
  approval_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
}

export interface KimiSubagentTask {
  id: string;
  session_id: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  output_preview?: string;
  subagent_phase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  subagent_type?: string;
}

export interface KimiSessionSnapshot {
  as_of_seq: number;
  epoch: string;
  session: KimiWireSession;
  messages: { items: KimiWireMessage[]; has_more: boolean };
  in_flight_turn: {
    turn_id: number;
    assistant_text: string;
    thinking_text: string;
    running_tools: KimiInFlightTool[];
    current_prompt_id?: string;
  } | null;
  subagents?: KimiSubagentTask[];
  pending_approvals: KimiPendingApproval[];
  pending_questions: KimiPendingQuestion[];
}

export interface KimiSessionStatus {
  busy: boolean;
  model?: string;
  thinking_level: string;
  permission: string;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}

export interface KimiPromptResult {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued' | 'blocked';
}

export type KimiPermissionMode = 'auto' | 'yolo';

export interface KimiDaemonClientOptions {
  executable?: string;
  serverUrl?: string;
  apiKey?: string;
}

export class KimiDaemonError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'KimiDaemonError';
  }
}

/**
 * Minimal first-party Kimi Code Server client for the Feishu bridge.
 *
 * Kimi Code 0.27 replaced the legacy `--wire --work-dir` protocol with its
 * local REST/WS frontend server. Feishu cards update far less frequently than
 * model token deltas, so an atomic `/snapshot` poll gives us reliable text,
 * tool, question, subagent, and completion state while the REST prompt queue
 * provides native mid-turn steering.
 */
export class KimiDaemonClient {
  private static readonly starts = new Map<string, Promise<void>>();

  readonly origin: string;
  private readonly executable: string;
  private readonly apiKey?: string;
  private ready = false;

  constructor(options: KimiDaemonClientOptions = {}) {
    this.origin = normalizeOrigin(options.serverUrl ?? process.env.KIMI_CODE_SERVER_URL ?? DEFAULT_ORIGIN);
    const hostname = new URL(this.origin).hostname;
    if (!isLoopbackHostname(hostname)) {
      throw new KimiDaemonError(`Personal edition only connects to a loopback Kimi Code server; got ${this.origin}`);
    }
    this.executable = options.executable ?? 'kimi';
    this.apiKey = options.apiKey;
  }

  async ensureRunning(): Promise<void> {
    if (this.ready) return;
    if (await this.probe()) {
      this.ready = true;
      return;
    }
    const existing = KimiDaemonClient.starts.get(this.origin);
    if (existing) {
      await existing;
      this.ready = true;
      return;
    }
    const start = this.startLocalServer().finally(() => KimiDaemonClient.starts.delete(this.origin));
    KimiDaemonClient.starts.set(this.origin, start);
    await start;
    this.ready = true;
  }

  async getSession(sessionId: string): Promise<KimiWireSession> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  async createSession(cwd: string, model?: string): Promise<KimiWireSession> {
    return this.request('/sessions', {
      title: path.basename(cwd) || 'MetaBot Kimi session',
      metadata: { cwd },
      ...(model ? { agent_config: { model } } : {}),
    });
  }

  async openSession(cwd: string, sessionId?: string, model?: string): Promise<KimiWireSession> {
    await this.ensureRunning();
    if (sessionId) return this.getSession(sessionId);
    return this.createSession(cwd, model);
  }

  async listSessions(cwd?: string): Promise<KimiWireSession[]> {
    await this.ensureRunning();
    const page = await this.request<{ items: KimiWireSession[]; has_more: boolean }>('/sessions', undefined, {
      page_size: 100,
      include_archive: false,
      exclude_empty: false,
    });
    return cwd ? page.items.filter((session) => session.metadata?.cwd === cwd) : page.items;
  }

  async getSnapshot(sessionId: string): Promise<KimiSessionSnapshot> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  }

  async getStatus(sessionId: string): Promise<KimiSessionStatus> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/status`);
  }

  async getGoal(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/goal`);
  }

  async submitPrompt(
    sessionId: string,
    text: string,
    options: {
      model?: string;
      thinking?: string;
      goalObjective?: string;
      permissionMode?: KimiPermissionMode;
    } = {},
  ): Promise<KimiPromptResult> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      content: [{ type: 'text', text }],
      permission_mode: options.permissionMode ?? 'auto',
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
      ...(options.goalObjective ? { goal_objective: options.goalObjective } : {}),
    });
  }

  async steer(sessionId: string, text: string, options: { model?: string; thinking?: string } = {}): Promise<void> {
    const queued = await this.submitPrompt(sessionId, text, options);
    // If the active turn ended in the submission race, Kimi starts this as a
    // normal follow-up in the same Session. Otherwise merge the queued prompt
    // into the active turn, matching the Kimi TUI's Ctrl+S behavior.
    if (queued.status !== 'queued') return;
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/prompts:steer`, {
      prompt_ids: [queued.prompt_id],
    });
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}:abort`, {});
  }

  async setGoal(sessionId: string, objective: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/profile`, {
      agent_config: { goal_objective: objective },
    });
  }

  async controlGoal(sessionId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/profile`, {
      agent_config: { goal_control: action },
    });
  }

  async approve(sessionId: string, approvalId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
      decision: 'approved',
      scope: 'session',
    });
  }

  async respondQuestion(
    sessionId: string,
    question: KimiPendingQuestion,
    answers: Record<string, string>,
  ): Promise<void> {
    const wireAnswers: Record<string, unknown> = {};
    for (const item of question.questions) {
      const raw = answers[item.question] ?? answers[item.id] ?? answers._answer ?? answers._auto ?? '';
      const labels = raw
        .split(/[,，\n]/)
        .map((value) => value.trim())
        .filter(Boolean);
      const selected = labels.flatMap((label) => item.options.filter((option) => option.label === label));
      if (item.multi_select && selected.length > 0) {
        wireAnswers[item.id] = { kind: 'multi', option_ids: selected.map((option) => option.id) };
      } else if (selected[0]) {
        wireAnswers[item.id] = { kind: 'single', option_id: selected[0].id };
      } else if (raw) {
        wireAnswers[item.id] = { kind: 'other', text: raw };
      } else {
        wireAnswers[item.id] = { kind: 'skipped' };
      }
    }
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(question.question_id)}`,
      { answers: wireAnswers, method: 'click' },
    );
  }

  /** Resolve a configured short model name against Kimi Code's current config. */
  async resolveModel(configured?: string): Promise<{ id: string; displayName: string }> {
    const config = await this.readConfig();
    const aliases = [...config.matchAll(/^\[models\."([^"]+)"\]/gm)].map((match) => match[1]);
    const defaultModel = config.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1];
    const requested = configured?.trim();
    const id =
      (requested && aliases.find((alias) => alias === requested || alias.endsWith(`/${requested}`))) ||
      requested ||
      defaultModel ||
      aliases[0] ||
      'kimi-code/k3';
    return { id, displayName: modelDisplayName(config, id) ?? id.split('/').at(-1) ?? id };
  }

  private async request<T>(
    resource: string,
    body?: unknown,
    query?: Record<string, string | number | boolean>,
  ): Promise<T> {
    await this.ensureRunning();
    try {
      return await this.rawRequest(resource, body, query);
    } catch (error) {
      // A transport failure means the cached readiness is stale even when the
      // failed request cannot be retried. API validation/provider errors carry
      // a numeric code and do not invalidate daemon readiness.
      if (!(error instanceof KimiDaemonError) || error.code !== undefined) throw error;
      this.ready = false;
      // Recover a bodyless GET once after a daemon restart or half-open local
      // connection. Never replay POSTs: the daemon may have accepted the
      // operation before the response was lost, so retrying could duplicate a
      // prompt or another side effect.
      if (body !== undefined) throw error;
      await this.ensureRunning();
      return this.rawRequest(resource, body, query);
    }
  }

  private async rawRequest<T>(
    resource: string,
    body?: unknown,
    query?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = new URL(`${this.origin}/api/v1${resource.startsWith('/') ? resource : `/${resource}`}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const token = await this.readToken();
    const headers: Record<string, string> = {
      'X-Kimi-Client-Id': 'metabot-feishu',
      'X-Kimi-Client-Name': 'MetaBot',
      'X-Kimi-Client-Version': '2',
      'X-Kimi-Client-Ui-Mode': 'bridge',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KimiDaemonError(
        `Kimi Code server request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let envelope: KimiEnvelope<T>;
    try {
      envelope = (await response.json()) as KimiEnvelope<T>;
    } catch {
      throw new KimiDaemonError(`Kimi Code server returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok || envelope.code !== 0) {
      throw new KimiDaemonError(
        envelope.msg || `Kimi Code server HTTP ${response.status}`,
        envelope.code,
        envelope.request_id,
      );
    }
    return envelope.data as T;
  }

  private async probe(): Promise<boolean> {
    try {
      await this.rawRequest('/healthz');
      return true;
    } catch {
      return false;
    }
  }

  private async startLocalServer(): Promise<void> {
    const url = new URL(this.origin);
    if (!isLoopbackHostname(url.hostname)) {
      throw new KimiDaemonError(`Kimi Code server is unavailable at ${this.origin}`);
    }
    const args = buildKimiServerArgs(url.port || '58627');
    const child = spawn(this.executable, args, {
      env: { ...process.env, ...(this.apiKey ? { KIMI_API_KEY: this.apiKey } : {}) },
      stdio: 'ignore',
      detached: true,
    });
    let spawnFailure: Error | undefined;
    child.once('error', (error) => {
      spawnFailure = error;
    });
    child.unref();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnFailure) throw new KimiDaemonError(`Failed to start Kimi Code: ${spawnFailure.message}`);
      if (await this.probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new KimiDaemonError(`Timed out starting Kimi Code server at ${this.origin}`);
  }

  private async readToken(): Promise<string | undefined> {
    try {
      const value = await readFile(path.join(kimiHome(), 'server.token'), 'utf8');
      return value.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async readConfig(): Promise<string> {
    try {
      return await readFile(path.join(kimiHome(), 'config.toml'), 'utf8');
    } catch {
      return '';
    }
  }
}

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function modelDisplayName(config: string, modelId: string): string | undefined {
  const header = `[models."${modelId}"]`;
  const start = config.indexOf(header);
  if (start < 0) return undefined;
  const rest = config.slice(start + header.length);
  const nextSection = rest.search(/^\[/m);
  const body = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  return body.match(/^\s*display_name\s*=\s*"([^"]+)"/m)?.[1];
}
