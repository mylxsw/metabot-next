import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  ApiError,
  type AgentSummary,
  type ChatConversation,
  type ChatFile,
  type ChatMessage,
  type ChatParticipant,
  type ChatParticipantInput,
  type ChatParticipantSearchResult,
  type ChatRun,
  type ChatRunEvent,
  type ChatRunStatus,
} from '../lib/api';
import { formatAbsolute, formatRelative } from '../lib/format';
import { renderMarkdown } from '../lib/render-markdown';

const REFRESH_MS = 1_200;
type ChatEngine = 'claude' | 'kimi' | 'codex';

const ENGINE_OPTIONS: Array<{ value: ChatEngine; label: string; defaultModel: string }> = [
  { value: 'claude', label: 'Claude', defaultModel: '' },
  { value: 'codex', label: 'Codex', defaultModel: '' },
  { value: 'kimi', label: 'Kimi', defaultModel: '' },
];

const COMMON_MODELS: Record<ChatEngine, string[]> = {
  claude: ['', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'],
  codex: ['', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.5'],
  kimi: ['', 'kimi-for-coding', 'kimi-k2'],
};

interface TimelineRun {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  targetAgentRef: string;
  engine?: string | null;
  model?: string | null;
  status: ChatRunStatus;
  updatedAt: string;
  latestText: string;
  events: ChatRunEvent[];
  localOnly?: boolean;
}

interface LiveToolCall {
  name: string;
  detail: string;
  status: string;
}

interface LiveQuestionOption {
  label: string;
  description: string;
}

interface LiveQuestion {
  toolUseId: string;
  header: string;
  question: string;
  options: LiveQuestionOption[];
}

function participantLabel(p: ChatParticipant): string {
  return p.displayName || p.ref;
}

function agentRefs(conv: ChatConversation | null): string[] {
  if (!conv) return [];
  return conv.participants.filter((p) => p.kind === 'agent').map((p) => p.ref);
}

function knownUserRefs(conversations: ChatConversation[] | null): string[] {
  const refs = new Set<string>();
  for (const conv of conversations || []) {
    for (const p of conv.participants) {
      if (p.kind === 'user') refs.add(p.ref);
    }
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function speechRecognitionCtor(): SpeechRecognitionConstructor | null {
  const win = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  readonly [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

function parseMentionedAgents(content: string, knownAgents: string[]): string[] {
  const out: string[] = [];
  for (const ref of knownAgents) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)@${escaped}(?=\\s|$|[,.!?;:])`, 'i');
    if (re.test(content)) out.push(ref);
  }
  return out;
}

function runIsActive(run: TimelineRun): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'waiting_user';
}

function runStatusLabel(status: ChatRunStatus): string {
  if (status === 'waiting_user') return 'waiting for input';
  return status.replace('_', ' ');
}

function modelStorageKey(conversationId: string): string {
  return `metabot-core-chat-model:${conversationId}`;
}

function loadModelChoice(conversationId: string): { engine: ChatEngine; model: string } {
  try {
    const raw = window.localStorage.getItem(modelStorageKey(conversationId));
    if (!raw) return { engine: 'codex', model: '' };
    const parsed = JSON.parse(raw) as { engine?: string; model?: string };
    const engine = parsed.engine === 'codex' || parsed.engine === 'kimi' || parsed.engine === 'claude'
      ? parsed.engine
      : 'codex';
    return { engine, model: typeof parsed.model === 'string' ? parsed.model : '' };
  } catch {
    return { engine: 'codex', model: '' };
  }
}

function saveModelChoice(conversationId: string, engine: ChatEngine, model: string): void {
  window.localStorage.setItem(modelStorageKey(conversationId), JSON.stringify({ engine, model }));
}

function parseModelCommand(content: string): { engine?: ChatEngine; model?: string; reset?: boolean } | null {
  const match = content.trim().match(/^\/model(?:\s+(.+))?$/i);
  if (!match) return null;
  const arg = (match[1] || '').trim();
  if (!arg || arg === 'list') return {};
  const normalized = arg.toLowerCase();
  if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') return { reset: true };
  if (normalized === 'claude' || normalized === 'kimi' || normalized === 'codex') return { engine: normalized };
  return { model: arg.split(/\s+/)[0] };
}

function eventType(event: ChatRunEvent): string {
  return event.type || event.kind || 'event';
}

function eventPayloadText(event: ChatRunEvent): string {
  const payload = event.payload ?? event.payloadJson;
  if (!payload || typeof payload !== 'object') return eventType(event);
  const obj = payload as Record<string, unknown>;
  if (typeof obj.error === 'string') return obj.error;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.message === 'string') return obj.message;
  const state = obj.state;
  if (state && typeof state === 'object') {
    const s = state as Record<string, unknown>;
    if (typeof s.errorMessage === 'string') return s.errorMessage;
    if (typeof s.responseText === 'string' && s.responseText.trim()) return s.responseText.trim();
    if (typeof s.status === 'string') return s.status;
  }
  return eventType(event);
}

function eventObject(event: ChatRunEvent): Record<string, unknown> {
  const payload = event.payload ?? event.payloadJson;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function latestRunState(run: TimelineRun): Record<string, unknown> | null {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const payload = eventObject(run.events[i]);
    if (payload.state && typeof payload.state === 'object' && !Array.isArray(payload.state)) {
      return payload.state as Record<string, unknown>;
    }
  }
  return null;
}

function liveRunText(run: TimelineRun): string {
  const state = latestRunState(run);
  if (state && typeof state.responseText === 'string' && state.responseText.trim()) {
    return state.responseText.trim();
  }
  return run.latestText === 'running' ? '' : run.latestText;
}

function liveRunTools(run: TimelineRun): LiveToolCall[] {
  const state = latestRunState(run);
  const raw = state && Array.isArray(state.toolCalls) ? state.toolCalls : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const tool = item as Record<string, unknown>;
    const name = typeof tool.name === 'string'
      ? tool.name
      : typeof tool.toolName === 'string' ? tool.toolName : 'tool';
    return [{
      name,
      detail: typeof tool.detail === 'string' ? tool.detail : '',
      status: typeof tool.status === 'string' ? tool.status : 'running',
    }];
  });
}

function pendingRunQuestions(run: TimelineRun): LiveQuestion[] {
  if (run.status !== 'waiting_user') return [];
  const event = [...run.events].reverse().find((item) => eventType(item) === 'question');
  if (!event) return [];
  const payload = eventObject(event);
  const questionRoot = payload.question && typeof payload.question === 'object'
    ? payload.question as Record<string, unknown>
    : payload;
  const toolUseId = typeof questionRoot.toolUseId === 'string'
    ? questionRoot.toolUseId
    : typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
  const questions = Array.isArray(questionRoot.questions) ? questionRoot.questions : [];
  return questions.flatMap((item) => {
    if (!toolUseId || !item || typeof item !== 'object') return [];
    const question = item as Record<string, unknown>;
    const text = typeof question.question === 'string' ? question.question : '';
    if (!text) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const option = raw as Record<string, unknown>;
          const label = typeof option.label === 'string' ? option.label : '';
          return label ? [{
            label,
            description: typeof option.description === 'string' ? option.description : '',
          }] : [];
        })
      : [];
    return [{
      toolUseId,
      header: typeof question.header === 'string' ? question.header : 'Agent needs your input',
      question: text,
      options,
    }];
  });
}

function formatFileSize(size: number | null): string {
  if (size === null || !Number.isFinite(size)) return 'output file';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeRun(input: ChatRun, fallbackTriggerMessageId: string): TimelineRun {
  const events = input.events || [];
  const lastEvent = events[events.length - 1];
  return {
    id: input.id,
    conversationId: input.conversationId,
    triggerMessageId: input.triggerMessageId || fallbackTriggerMessageId,
    targetAgentRef: input.targetAgentRef,
    engine: input.engine,
    model: input.model,
    status: input.status,
    updatedAt: input.updatedAt || lastEvent?.createdAt || new Date().toISOString(),
    latestText: input.error || (lastEvent ? eventPayloadText(lastEvent) : ''),
    events,
  };
}

function createLocalRun(
  conversationId: string,
  triggerMessageId: string,
  targetAgentRef: string,
): TimelineRun {
  const now = new Date().toISOString();
  return {
    id: `local-${triggerMessageId}-${targetAgentRef}`,
    conversationId,
    triggerMessageId,
    targetAgentRef,
    status: 'queued',
    updatedAt: now,
    latestText: 'waiting for backend run delivery',
    events: [],
    localOnly: true,
  };
}

function sameMessageList(a: ChatMessage[] | null, b: ChatMessage[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.content !== right.content ||
      left.runId !== right.runId ||
      left.createdAt !== right.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function applyCompletedRunMessages(
  current: Record<string, TimelineRun[]>,
  rows: ChatMessage[],
): Record<string, TimelineRun[]> {
  const completed = new Set(
    rows
      .filter((msg) => msg.kind === 'assistant' && msg.runId)
      .map((msg) => msg.runId as string),
  );
  if (completed.size === 0) return current;
  let changed = false;
  const next: Record<string, TimelineRun[]> = {};
  for (const [messageId, runs] of Object.entries(current)) {
    next[messageId] = runs.map((run) => {
      if (!completed.has(run.id) || run.status === 'completed') return run;
      changed = true;
      return {
        ...run,
        status: 'completed',
        latestText: run.latestText || 'final response received',
        updatedAt: new Date().toISOString(),
      };
    });
  }
  return changed ? next : current;
}

function ConversationRow({
  conv,
  active,
  onClick,
}: {
  conv: ChatConversation;
  active: boolean;
  onClick: () => void;
}) {
  const names = conv.participants
    .filter((p) => !(p.kind === 'user' && p.ref === conv.createdBy))
    .map(participantLabel)
    .slice(0, 3)
    .join(', ');
  return (
    <li
      className={'chat-conversation-row' + (active ? ' active' : '')}
      onClick={onClick}
      role="button"
    >
      <div className="chat-conversation-title">
        <span>{conv.title}</span>
        {conv.unreadCount > 0 && <strong>{conv.unreadCount}</strong>}
      </div>
      <div className="chat-conversation-preview">
        {conv.lastMessage?.content || names || 'no messages yet'}
      </div>
      <div className="chat-conversation-meta">
        <span>{conv.kind}</span>
        <span>{conv.lastMessageAt ? formatRelative(conv.lastMessageAt) : 'new'}</span>
      </div>
    </li>
  );
}

function LiveQuestionCard({
  question,
  disabled,
  onAnswer,
}: {
  question: LiveQuestion;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [customAnswer, setCustomAnswer] = useState('');
  return (
    <div className="chat-live-question">
      <small>{question.header}</small>
      <p>{question.question}</p>
      {question.options.length > 0 && (
        <div>
          {question.options.map((option) => (
            <button type="button" key={option.label} disabled={disabled} onClick={() => onAnswer(option.label)}>
              <strong>{option.label}</strong>
              {option.description && <span>{option.description}</span>}
            </button>
          ))}
        </div>
      )}
      <form
        className="chat-live-question-custom"
        onSubmit={(event) => {
          event.preventDefault();
          if (customAnswer.trim()) onAnswer(customAnswer.trim());
        }}
      >
        <input
          value={customAnswer}
          disabled={disabled}
          onChange={(event) => setCustomAnswer(event.target.value)}
          placeholder="Type another answer"
        />
        <button type="submit" disabled={disabled || !customAnswer.trim()}>Answer</button>
      </form>
    </div>
  );
}

function LiveRunCard({
  run,
  files,
  onAnswer,
  onCancel,
}: {
  run: TimelineRun;
  files: ChatFile[];
  onAnswer: (runId: string, toolUseId: string, answer: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const tools = liveRunTools(run);
  const questions = pendingRunQuestions(run);
  const text = liveRunText(run);

  const control = async (action: () => Promise<void>) => {
    setControlBusy(true);
    setControlError(null);
    try {
      await action();
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'control failed');
    } finally {
      setControlBusy(false);
    }
  };

  return (
    <div className={`chat-live-run ${run.status}${runIsActive(run) ? ' active' : ''}`}>
      <div className="chat-live-run-head">
        <span className="chat-live-status-dot" aria-hidden="true" />
        <strong>@{run.targetAgentRef}</strong>
        <span>{runStatusLabel(run.status)}</span>
        {(run.engine || run.model) && (
          <small>{[run.engine, run.model].filter(Boolean).join(' · ')}</small>
        )}
        {runIsActive(run) && !run.localOnly && (
          <button type="button" disabled={controlBusy} onClick={() => void control(() => onCancel(run.id))}>
            Stop
          </button>
        )}
      </div>
      {text && run.status !== 'completed' && (
        <div className="chat-live-response chat-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      )}
      {tools.length > 0 && (
        <details className="chat-live-tools" open={tools.some((tool) => tool.status === 'running')}>
          <summary>{tools.some((tool) => tool.status === 'running') ? `Running ${tools.at(-1)?.name}` : `${tools.length} tools used`}</summary>
          <div>
            {tools.map((tool, index) => (
              <span key={`${tool.name}-${index}`} className={tool.status}>
                <i aria-hidden="true" />
                <strong>{tool.name}</strong>
                {tool.detail && <small>{tool.detail}</small>}
              </span>
            ))}
          </div>
        </details>
      )}
      {questions.map((question) => (
        <LiveQuestionCard
          key={`${question.toolUseId}:${question.question}`}
          question={question}
          disabled={controlBusy}
          onAnswer={(answer) => void control(() => onAnswer(run.id, question.toolUseId, answer))}
        />
      ))}
      {files.length > 0 && (
        <div className="chat-live-files">
          {files.map((file) => (
            <div key={file.id} className="chat-live-file">
              <span aria-hidden="true">↧</span>
              <div><strong>{file.name}</strong><small>{file.mimeType} · {formatFileSize(file.sizeBytes)}</small></div>
            </div>
          ))}
        </div>
      )}
      {controlError && <div className="chat-live-control-error">{controlError}</div>}
    </div>
  );
}

function RunStatePanel({
  runs,
  files,
  onAnswer,
  onCancel,
}: {
  runs: TimelineRun[];
  files: ChatFile[];
  onAnswer: (runId: string, toolUseId: string, answer: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="chat-run-list">
      {runs.map((run) => <LiveRunCard
        key={run.id}
        run={run}
        files={files.filter((file) => file.runId === run.id)}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />)}
    </div>
  );
}

function MessageBubble({
  msg,
  runs,
  files,
  onAnswer,
  onCancel,
}: {
  msg: ChatMessage;
  runs: TimelineRun[];
  files: ChatFile[];
  onAnswer: (runId: string, toolUseId: string, answer: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  return (
    <>
      <div className={`chat-message ${msg.kind} ${msg.senderKind}`}>
        <div className="chat-message-head">
          <span>{msg.senderDisplayName}</span>
          <time title={formatAbsolute(msg.createdAt)}>{formatRelative(msg.createdAt)}</time>
        </div>
        {msg.kind === 'assistant' ? (
          <div className="chat-message-body chat-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
        ) : (
          <div className="chat-message-body">{msg.content}</div>
        )}
        {msg.mentionedAgentRefs.length > 0 && (
          <div className="chat-message-triggers">
            {msg.mentionedAgentRefs.map((ref) => <span key={ref}>@{ref}</span>)}
          </div>
        )}
        {runs.length === 0 && msg.kind === 'assistant' && msg.runId && (
          <div className="chat-message-run-link">run {msg.runId} completed</div>
        )}
      </div>
      {runs.length > 0 && (
        <div className="chat-message assistant agent chat-live-message">
          <div className="chat-message-head"><span>Agent run</span></div>
          <RunStatePanel runs={runs} files={files} onAnswer={onAnswer} onCancel={onCancel} />
        </div>
      )}
    </>
  );
}

function AgentPicker({
  agents,
  selected,
  onToggle,
  single = false,
}: {
  agents: AgentSummary[];
  selected: string[];
  onToggle: (ref: string) => void;
  single?: boolean;
}) {
  if (agents.length === 0) {
    return <div className="chat-picker-empty">no visible agents</div>;
  }
  return (
    <div className="chat-agent-picker">
      {agents.map((agent) => {
        const checked = selected.includes(agent.botName);
        return (
          <button
            key={agent.botName}
            type="button"
            className={checked ? 'selected' : ''}
            onClick={() => onToggle(agent.botName)}
            aria-pressed={checked}
          >
            <span>@{agent.botName}</span>
            <small>{agent.host}</small>
            <strong>{single ? 'dm' : checked ? 'added' : 'add'}</strong>
          </button>
        );
      })}
    </div>
  );
}

function parseUserRefs(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function activeSearchToken(value: string): string {
  const parts = value.split(/[\s,;]+/).filter(Boolean);
  return parts[parts.length - 1]?.trim() || '';
}

function addUserToList(value: string, ref: string): string {
  const refs = new Set(parseUserRefs(value));
  refs.add(ref.toLowerCase());
  return [...refs].join(', ');
}

function useParticipantSearch(query: string, kind?: 'user' | 'agent'): ChatParticipantSearchResult[] {
  const [results, setResults] = useState<ChatParticipantSearchResult[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return undefined;
    }
    let live = true;
    api.searchChatParticipants(q)
      .then(({ participants }) => {
        if (!live) return;
        setResults(kind ? participants.filter((p) => p.kind === kind) : participants);
      })
      .catch(() => {
        if (live) setResults([]);
      });
    return () => { live = false; };
  }, [query, kind]);
  return results;
}

function NewChatPanel({
  agents,
  userSuggestions,
  onCreated,
}: {
  agents: AgentSummary[];
  userSuggestions: string[];
  onCreated: (conv: ChatConversation) => void;
}) {
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [userText, setUserText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedUsers = useMemo(() => parseUserRefs(userText), [userText]);
  const searchedUsers = useParticipantSearch(activeSearchToken(userText), 'user');
  const suggestedUsers = useMemo(() => {
    const refs = new Set<string>();
    for (const item of searchedUsers) refs.add(item.ref);
    for (const item of userSuggestions) refs.add(item);
    return [...refs].filter((ref) => !selectedUsers.includes(ref)).slice(0, 6);
  }, [searchedUsers, userSuggestions, selectedUsers]);
  const canCreate = mode === 'dm' ? selectedAgents.length === 1 : selectedAgents.length + selectedUsers.length > 0;

  const toggleAgent = (ref: string) => {
    setSelectedAgents((cur) => {
      if (mode === 'dm') return cur[0] === ref ? [] : [ref];
      return cur.includes(ref) ? cur.filter((item) => item !== ref) : [...cur, ref];
    });
  };

  const create = async () => {
    if (!canCreate || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'dm') {
        const conv = await api.findOrCreateAgentDm(selectedAgents[0]);
        onCreated(conv);
        return;
      }
      const participants: ChatParticipantInput[] = [
        ...selectedAgents.map((ref) => ({ kind: 'agent' as const, ref })),
        ...selectedUsers.map((ref) => ({ kind: 'user' as const, ref })),
      ];
      const conv = await api.createChatConversation('group', title.trim() || undefined, participants);
      onCreated(conv);
      setTitle('');
      setUserText('');
      setSelectedAgents([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-new-panel">
      <div className="chat-new-head">
        <span>New</span>
        <div className="chat-mode-switch">
          <button type="button" className={mode === 'dm' ? 'active' : ''} onClick={() => setMode('dm')}>
            DM
          </button>
          <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
            group
          </button>
        </div>
      </div>
      {mode === 'group' && (
        <input
          className="chat-new-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="group title"
        />
      )}
      <div className="chat-new-label">Agents</div>
      <AgentPicker
        agents={agents}
        selected={selectedAgents}
        onToggle={toggleAgent}
        single={mode === 'dm'}
      />
      {mode === 'group' && (
        <>
          <div className="chat-new-label">People</div>
          <input
            className="chat-new-input"
            value={userText}
            onChange={(e) => setUserText(e.target.value)}
            placeholder="user emails, separated by comma"
          />
          {suggestedUsers.length > 0 && (
            <div className="chat-user-suggestions">
              {suggestedUsers.map((ref) => (
                <button
                  key={ref}
                  type="button"
                  onClick={() => setUserText((cur) => addUserToList(cur, ref))}
                >
                  {ref}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="chat-inline-error">{error}</div>}
      <button type="button" className="chat-create-button" disabled={!canCreate || busy} onClick={() => void create()}>
        {busy ? 'Opening' : mode === 'dm' ? 'Open chat' : 'Create'}
      </button>
    </div>
  );
}

function ParticipantManager({
  selected,
  agents,
  userSuggestions,
  onChanged,
}: {
  selected: ChatConversation;
  agents: AgentSummary[];
  userSuggestions: string[];
  onChanged: (conv: ChatConversation) => void;
}) {
  const [kind, setKind] = useState<'agent' | 'user'>('agent');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searched = useParticipantSearch(ref, kind);
  const existing = useMemo(
    () => new Set(selected.participants.map((p) => `${p.kind}:${p.ref}`)),
    [selected.participants],
  );
  const availableAgents = agents.filter((agent) => !existing.has(`agent:${agent.botName}`));
  const searchedRefs = searched.map((item) => item.ref);
  const availableUsers = [...new Set([...searchedRefs, ...userSuggestions])]
    .filter((user) => !existing.has(`user:${user}`));

  const add = async (nextKind: 'agent' | 'user' = kind, nextRef = ref) => {
    const cleanRef = nextRef.trim();
    if (!cleanRef || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addChatParticipant(selected.id, { kind: nextKind, ref: cleanRef });
      const conv = await api.getChatConversation(selected.id);
      onChanged(conv);
      setRef('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-participant-manager">
      <div className="chat-add-controls">
        <div className="chat-mode-switch">
          <button type="button" className={kind === 'agent' ? 'active' : ''} onClick={() => setKind('agent')}>
            agent
          </button>
          <button type="button" className={kind === 'user' ? 'active' : ''} onClick={() => setKind('user')}>
            user
          </button>
        </div>
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={kind === 'agent' ? 'agent name' : 'user email'}
          list={kind === 'agent' ? 'chat-agent-options' : 'chat-user-options'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button type="button" disabled={!ref.trim() || busy} onClick={() => void add()}>
          add
        </button>
      </div>
      <datalist id="chat-agent-options">
        {availableAgents.map((agent) => <option key={agent.botName} value={agent.botName} />)}
      </datalist>
      <datalist id="chat-user-options">
        {availableUsers.map((user) => <option key={user} value={user} />)}
      </datalist>
      {kind === 'agent' && availableAgents.length > 0 && (
        <div className="chat-quick-add">
          {availableAgents.slice(0, 6).map((agent) => (
            <button key={agent.botName} type="button" onClick={() => void add('agent', agent.botName)}>
              @{agent.botName}
            </button>
          ))}
        </div>
      )}
      {kind === 'user' && availableUsers.length > 0 && (
        <div className="chat-quick-add">
          {availableUsers.slice(0, 6).map((user) => (
            <button key={user} type="button" onClick={() => void add('user', user)}>
              {user}
            </button>
          ))}
        </div>
      )}
      {error && <div className="chat-inline-error">{error}</div>}
    </div>
  );
}

function Composer({
  disabled,
  knownAgents,
  engine,
  model,
  onEngineChange,
  onModelChange,
  onSend,
}: {
  disabled: boolean;
  knownAgents: string[];
  engine: ChatEngine;
  model: string;
  onEngineChange: (engine: ChatEngine) => void;
  onModelChange: (model: string) => void;
  onSend: (content: string, mentions: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'listening' | 'transcribing' | 'unsupported' | 'error'>('idle');
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mentions = useMemo(() => parseMentionedAgents(value, knownAgents), [value, knownAgents]);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    recorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
  }, [value]);

  const appendTranscript = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setValue((cur) => `${cur}${cur.endsWith(' ') || !cur ? '' : ' '}${clean}`);
  };

  const startBrowserSpeechFallback = () => {
    if (voiceState === 'listening') {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      setVoiceState('unsupported');
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onstart = () => setVoiceState('listening');
    recognition.onend = () => {
      recognitionRef.current = null;
      setVoiceState((cur) => (cur === 'listening' ? 'idle' : cur));
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setVoiceState('error');
    };
    recognition.onresult = (event) => {
      const chunks: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal && result[0]?.transcript) chunks.push(result[0].transcript.trim());
      }
      if (chunks.length > 0) {
        appendTranscript(chunks.join(' '));
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setVoiceState('error');
      recognitionRef.current = null;
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const toggleVoice = async () => {
    if (voiceState === 'recording') {
      stopRecording();
      return;
    }
    if (voiceState === 'listening') {
      recognitionRef.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      startBrowserSpeechFallback();
      return;
    }
    try {
      setVoiceHint(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setVoiceState('error');
        setVoiceHint('recording failed');
      };
      recorder.onstop = () => {
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        recorderRef.current = null;
        if (chunks.length === 0) {
          setVoiceState('idle');
          return;
        }
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        setVoiceState('transcribing');
        setVoiceHint('Doubao STT');
        api.transcribeChatVoice(audio, { stt: 'doubao', language: navigator.language?.startsWith('zh') ? 'zh' : 'en' })
          .then((res) => {
            if (res.transcript) {
              appendTranscript(res.transcript);
              setVoiceHint('transcribed');
            } else {
              setVoiceHint(res.error || 'no speech detected');
            }
            setVoiceState('idle');
          })
          .catch(() => {
            setVoiceState('error');
            setVoiceHint('Doubao STT unavailable');
          });
      };
      recorder.start();
      setVoiceState('recording');
      setVoiceHint('recording');
    } catch {
      startBrowserSpeechFallback();
    }
  };

  const submit = async () => {
    const content = value.trim();
    if (!content || disabled || sending) return;
    setSending(true);
    try {
      await onSend(content, mentions);
      setValue('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-composer">
      <div className="chat-composer-shell">
        <details className="chat-composer-settings">
          <summary>{engine}{model ? ` / ${model}` : ''}</summary>
          <div className="chat-composer-tools">
            <label>
              <span>Engine</span>
              <select
                value={engine}
                disabled={disabled || sending}
                onChange={(e) => onEngineChange(e.target.value as ChatEngine)}
              >
                {ENGINE_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Model</span>
              <input
                value={model}
                disabled={disabled || sending}
                onChange={(e) => onModelChange(e.target.value)}
                placeholder={`${engine} default`}
                list={`chat-model-options-${engine}`}
              />
              <datalist id={`chat-model-options-${engine}`}>
                {COMMON_MODELS[engine].map((item) => (
                  <option key={item || 'default'} value={item} />
                ))}
              </datalist>
            </label>
          </div>
        </details>
        <div className="chat-capability-strip">
          <span>Doubao STT</span>
          <span>voice input</span>
          <span>tool activity</span>
        </div>
        {knownAgents.length > 0 && (
          <div className="chat-agent-hints">
            {knownAgents.map((ref) => (
              <button
                key={ref}
                type="button"
                onClick={() => setValue((cur) => `${cur}${cur.endsWith(' ') || !cur ? '' : ' '}@${ref} `)}
              >
                @{ref}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled || sending}
          placeholder={knownAgents.length ? `Message @${knownAgents[0]} or type /model codex` : 'Message'}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="chat-composer-actions">
          {voiceState === 'unsupported' && <span>voice unsupported</span>}
          {voiceState === 'error' && <span>voice unavailable</span>}
          {voiceHint && voiceState !== 'error' && <span className="chat-voice-hint">{voiceHint}</span>}
          <button
            type="button"
            className={`chat-voice-button ${voiceState}`}
            disabled={disabled || sending || voiceState === 'transcribing'}
            onClick={toggleVoice}
            title={voiceState === 'recording' || voiceState === 'listening' ? 'stop voice input' : 'start voice input'}
            aria-pressed={voiceState === 'recording' || voiceState === 'listening'}
          >
            {voiceState === 'recording' || voiceState === 'listening' ? 'Stop' : voiceState === 'transcribing' ? 'STT' : 'Mic'}
          </button>
          <button type="button" disabled={disabled || sending || !value.trim()} onClick={() => void submit()}>
            {sending ? 'Sending' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Chat() {
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<ChatConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [runsByMessageId, setRunsByMessageId] = useState<Record<string, TimelineRun[]>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [engine, setEngine] = useState<ChatEngine>('codex');
  const [model, setModel] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loc = useLocation();
  const nav = useNavigate();
  const endRef = useRef<HTMLDivElement | null>(null);

  const params = new URLSearchParams(loc.search);
  const selectedId = params.get('c');
  const agent = params.get('agent');
  const listMode = params.get('list') === '1';

  const refreshConversations = useCallback(async () => {
    const res = await api.listChatConversations();
    setConversations(res.conversations);
    return res.conversations;
  }, []);

  useEffect(() => {
    let live = true;
    api.listAgents()
      .then(({ agents }) => {
        if (live) setAvailableAgents(agents.filter((item) => item.visible));
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setAvailableAgents([]);
      });
    return () => { live = false; };
  }, []);

  const refreshActiveConversation = useCallback(async (
    conversationId: string,
    options: { showRefreshing?: boolean; markRead?: boolean } = {},
  ) => {
    if (options.showRefreshing) setRefreshing(true);
    try {
      const [{ messages: rows }, { runs }, { files: fileRows }, list] = await Promise.all([
        api.listChatMessages(conversationId),
        api.listChatRuns(conversationId),
        api.listChatFiles(conversationId),
        refreshConversations(),
      ]);
      const runsWithEvents = await Promise.all(
        runs.map(async (run) => {
          const { events } = await api.listChatRunEvents(run.id);
          return normalizeRun({ ...run, events }, run.triggerMessageId || '');
        }),
      );
      const nextRunsByMessageId: Record<string, TimelineRun[]> = {};
      for (const run of runsWithEvents) {
        if (!run.triggerMessageId) continue;
        const bucket = nextRunsByMessageId[run.triggerMessageId] || [];
        bucket.push(run);
        nextRunsByMessageId[run.triggerMessageId] = bucket;
      }
      setMessages((cur) => (sameMessageList(cur, rows) ? cur : rows));
      setFiles(fileRows);
      setRunsByMessageId(applyCompletedRunMessages(nextRunsByMessageId, rows));
      setSelected((cur) => list.find((c) => c.id === conversationId) || cur);
      setLastRefreshAt(new Date().toISOString());
      if (options.markRead !== false) {
        const last = rows[rows.length - 1];
        if (last) void api.markChatRead(conversationId, last.id).catch(() => undefined);
      }
      return rows;
    } finally {
      if (options.showRefreshing) setRefreshing(false);
    }
  }, [refreshConversations]);

  useEffect(() => {
    let live = true;
    setErr(null);
    (async () => {
      try {
        if (agent) {
          const dm = await api.findOrCreateAgentDm(agent);
          if (!live) return;
          setSelected(dm);
          setMessages(null);
          await refreshConversations();
          nav(`/chat?c=${encodeURIComponent(dm.id)}`, { replace: true });
          return;
        }
        const list = await refreshConversations();
        if (!live) return;
        const next = listMode ? null : (selectedId && list.find((c) => c.id === selectedId)) || list[0] || null;
        setSelected(next);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setErr(e instanceof Error ? e.message : 'failed');
      }
    })();
    return () => { live = false; };
  }, [agent, selectedId, listMode]);

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      setFiles([]);
      setRunsByMessageId({});
      return undefined;
    }
    const choice = loadModelChoice(selected.id);
    setEngine(choice.engine);
    setModel(choice.model);
    setMessages(null);
    let live = true;
    refreshActiveConversation(selected.id)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setErr(e instanceof Error ? e.message : 'failed');
      });
    return () => { live = false; };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        setErr(null);
        await refreshActiveConversation(selected.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        if (!stopped) setErr(e instanceof Error ? e.message : 'failed');
      }
    };
    const timer = window.setInterval(() => { void tick(); }, REFRESH_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [selected?.id, refreshActiveConversation]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, selected?.id]);

  const selectConversation = (conv: ChatConversation) => {
    setSelected(conv);
    nav(`/chat?c=${encodeURIComponent(conv.id)}`);
  };

  const conversationCreated = async (conv: ChatConversation) => {
    setShowNewChat(false);
    setSelected(conv);
    setMessages(null);
    await refreshConversations();
    nav(`/chat?c=${encodeURIComponent(conv.id)}`);
  };

  const participantChanged = async (conv: ChatConversation) => {
    setSelected(conv);
    await refreshConversations();
  };

  const send = async (content: string, mentionedAgentRefs: string[]) => {
    if (!selected) return;
    const command = parseModelCommand(content);
    if (command) {
      const nextEngine = command.reset ? 'codex' : command.engine || engine;
      const nextModel = command.reset || command.engine ? '' : command.model ?? model;
      setEngine(nextEngine);
      setModel(nextModel);
      saveModelChoice(selected.id, nextEngine, nextModel);
      return;
    }
    const cleanModel = model.trim();
    const res = await api.postChatMessage(selected.id, content, mentionedAgentRefs, {
      engine,
      ...(cleanModel ? { model: cleanModel } : {}),
    });
    setMessages((cur) => [...(cur || []), res.message]);
    const responseRuns = [
      ...(res.runs || []).map((run) => normalizeRun(run, res.message.id)),
    ];
    const localRuns = responseRuns.length === 0 && (res.runsCreated > 0 || res.agentTriggers.length > 0)
      ? res.agentTriggers.map((ref) => createLocalRun(selected.id, res.message.id, ref))
      : [];
    setRunsByMessageId((cur) => ({
      ...cur,
      [res.message.id]: [
        ...(cur[res.message.id] || []),
        ...responseRuns,
        ...localRuns,
      ],
    }));
    if (res.runEvents?.length) {
      setRunsByMessageId((cur) => {
        const byRun = new Map<string, TimelineRun>();
        for (const runs of Object.values(cur)) {
          for (const run of runs) byRun.set(run.id, run);
        }
          for (const event of res.runEvents || []) {
          const run = byRun.get(event.runId);
          if (!run) continue;
          const events = [...run.events.filter((e) => e.seq !== event.seq), event]
            .sort((a, b) => a.seq - b.seq);
          byRun.set(run.id, {
            ...run,
            status: eventType(event) === 'complete'
              ? 'completed'
              : eventType(event) === 'error'
                ? 'failed'
                : eventType(event) === 'canceled' ? 'canceled' : run.status,
            latestText: eventPayloadText(event),
            updatedAt: event.createdAt,
            events,
          });
        }
        const next: Record<string, TimelineRun[]> = {};
        for (const runs of Object.values(cur)) {
          for (const run of runs) {
            const merged = byRun.get(run.id) || run;
            const arr = next[merged.triggerMessageId] || [];
            arr.push(merged);
            next[merged.triggerMessageId] = arr;
          }
        }
        return next;
      });
    }
    const list = await refreshConversations();
    setSelected(list.find((c) => c.id === selected.id) || selected);
    void refreshActiveConversation(selected.id, { showRefreshing: true });
  };

  const answerRun = async (runId: string, toolUseId: string, answer: string) => {
    await api.answerChatRun(runId, toolUseId, answer);
    if (selected) await refreshActiveConversation(selected.id, { showRefreshing: true, markRead: false });
  };

  const cancelRun = async (runId: string) => {
    await api.cancelChatRun(runId);
    if (selected) await refreshActiveConversation(selected.id, { showRefreshing: true, markRead: false });
  };

  const agents = agentRefs(selected);
  const users = knownUserRefs(conversations);

  return (
    <div className={`main chat-main ${selected ? 'chat-has-selected' : 'chat-no-selection'}`}>
      <aside className="sidebar chat-sidebar">
        <button
          type="button"
          className="chat-new-toggle"
          onClick={() => setShowNewChat((cur) => !cur)}
          aria-expanded={showNewChat}
        >
          {showNewChat ? 'Close' : '+ New'}
        </button>
        {showNewChat && (
          <NewChatPanel agents={availableAgents} userSuggestions={users} onCreated={(conv) => void conversationCreated(conv)} />
        )}
        <div className="sidebar-section">
          <span>Conversations</span>
          <span className="count">{conversations?.length ?? '—'}</span>
        </div>
        {err && <div className="sidebar-section">chat unavailable · {err}</div>}
        {!err && !conversations && <div className="sidebar-section">loading…</div>}
        {!err && conversations && conversations.length === 0 && (
          <div className="sidebar-section">start a dm or group above</div>
        )}
        {conversations && conversations.length > 0 && (
          <ul className="chat-conversation-list">
            {conversations.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                active={conv.id === selected?.id}
                onClick={() => selectConversation(conv)}
              />
            ))}
          </ul>
        )}
      </aside>
      <div className="content chat-content">
        <div className="page-head chat-page-head">
          <div>
            <h1>{selected?.title || 'chat'}</h1>
          </div>
          <div className="chat-head-actions">
            {selected && (
              <button
                type="button"
                className="chat-mobile-list-button"
                onClick={() => {
                  setSelected(null);
                  setMessages([]);
                  setRunsByMessageId({});
                  nav('/chat?list=1');
                }}
              >
                Chats
              </button>
            )}
            <span className={`chat-refresh-state${refreshing ? ' active' : ''}`}>
              {refreshing ? 'syncing' : lastRefreshAt ? formatRelative(lastRefreshAt) : 'live'}
            </span>
            <span className="crumbs">
              {selected ? `${selected.kind} · ${selected.participants.length}` : '/ chat'}
            </span>
          </div>
        </div>
        {err && <div className="state err">{err}</div>}
        {!err && !selected && (
          <div className="chat-empty-state">
            <div className="kicker">ready</div>
            <h2>Start a conversation</h2>
            <p>Open an agent DM or create a focused group from the left rail.</p>
          </div>
        )}
        {!err && selected && (
          <div className="chat-workspace">
            <div className="chat-thread-head">
              <div className="chat-participants">
                {selected.participants.map((p) => (
                  <span key={`${p.kind}:${p.ref}`} className={`chat-participant ${p.kind}`}>
                    {p.kind === 'agent' ? '@' : ''}{participantLabel(p)}
                  </span>
                ))}
              </div>
            </div>
            {selected.kind === 'group' && (
              <details className="chat-thread-settings">
                <summary>Manage participants</summary>
                <ParticipantManager
                  selected={selected}
                  agents={availableAgents}
                  userSuggestions={users}
                  onChanged={(conv) => void participantChanged(conv)}
                />
              </details>
            )}
            <div className="chat-timeline">
              {!messages && <div className="state"><span className="cursor">loading</span></div>}
              {messages && messages.length === 0 && (
                <div className="chat-empty-state compact">
                  <div className="kicker">empty conversation</div>
                  <h2>No messages yet</h2>
                  <p>
                    {selected.kind === 'dm'
                      ? 'Send a message to start the agent run.'
                      : agents.length > 0
                        ? `Mention @${agents[0]} to start an agent run.`
                        : 'Add an agent above, or use this group as a user chat.'}
                  </p>
                </div>
              )}
              {messages?.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  runs={runsByMessageId[msg.id] || []}
                  files={files}
                  onAnswer={answerRun}
                  onCancel={cancelRun}
                />
              ))}
              <div ref={endRef} />
            </div>
            <Composer
              disabled={!selected}
              knownAgents={agents}
              engine={engine}
              model={model}
              onEngineChange={(nextEngine) => {
                setEngine(nextEngine);
                setModel('');
                if (selected) saveModelChoice(selected.id, nextEngine, '');
              }}
              onModelChange={(nextModel) => {
                setModel(nextModel);
                if (selected) saveModelChoice(selected.id, engine, nextModel);
              }}
              onSend={send}
            />
          </div>
        )}
      </div>
    </div>
  );
}
