/**
 * TS port of t5t-portal/backend/app/models/schemas.py (HEAD 3463efb).
 *
 * Naming convention is camelCase to match the rest of metabot-core; the
 * underlying t5t docs are stored as JSON in MemoryStore.document.content, so
 * the snake_case Pydantic field names don't leak past this file.
 */

export type ProjectStatus = 'green' | 'yellow' | 'red' | 'killed' | 'unknown';
export type WipStatus = 'queued' | 'doing' | 'done';
export type TopFiveStatus = 'open' | 'done' | 'removed';
export type AnomalyReason =
  | 'no_owner'
  | 'stale'
  | 'kill_red'
  | 'no_goal'
  | 'no_evaluator'
  | 'stale_bottleneck';

export interface Goal {
  project: string;
  goalId: string;
  text: string;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  docId: string;
}

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

export interface WhoamiResponse {
  source: 'web' | 'cli';
  canonicalEmail: string;
  botName: string;
  role: 'admin' | 'member';
}

export interface ProjectCreateInput {
  slug: string;
  name?: string;
  leaderEmail?: string | null;
  allowedUsers?: string[];
  status?: ProjectStatus;
  killCriteria?: string | null;
}
