import * as crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { Credential } from '../auth/credentials.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { T5tFolderIds } from './folder-ids.js';
import type {
  AnomalyItem,
  Bottleneck,
  Evaluator,
  FeedbackEntry,
  Goal,
  ProjectCreateInput,
  ProjectSummary,
  T5TEntry,
  TopFiveItem,
  TopFiveStatus,
  WIPBoardColumn,
  WIPItem,
  WipStatus,
} from './types.js';

/**
 * Stale-project threshold in days. Mirrors t5t-portal SETTINGS.stale_threshold_days
 * default (7). Constant for v1 — promote to env if a caller asks.
 */
const STALE_DAYS = 7;
const STALE_BOTTLENECK_DAYS = 3;
const NO_GOAL_GRACE_HOURS = 24;

/**
 * Every payload carries `appendSeq` — a process-monotonic counter set in
 * `createDoc()` right before persistence. It exists ONLY to break createdAt
 * ties (two appends in the same millisecond, common under test load), so
 * latest-doc-wins remains deterministic. Read paths compare on the tuple
 * `(createdAt, appendSeq)` via `isNewer()`.
 */
interface ProjectDoc {
  kind: 'project';
  slug: string;
  name: string;
  leaderEmail: string | null;
  allowedUsers: string[];
  status: ProjectSummary['status'];
  killCriteria: string | null;
  author: string;
  authorCanonical: string;
  createdAt: string;
  appendSeq: number;
}

interface GoalDoc {
  kind: 'goal';
  project: string;
  goalId: string;
  text: string;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  appendSeq: number;
}

interface EvaluatorDoc {
  kind: 'evaluator';
  project: string;
  evaluatorId: string;
  description: string;
  met: boolean;
  seq: number;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  appendSeq: number;
}

interface BottleneckDoc {
  kind: 'bottleneck';
  project: string;
  bottleneckId: string;
  text: string;
  cleared: boolean;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  appendSeq: number;
}

interface WipDoc {
  kind: 'wip';
  project: string;
  evaluatorId: string;
  wipId: string;
  description: string;
  status: WipStatus;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  appendSeq: number;
}

interface TopFiveDoc {
  kind: 'topfive';
  project: string;
  itemId: string;
  text: string;
  status: TopFiveStatus;
  author: string;
  authorCanonical: string;
  replaces: string | null;
  createdAt: string;
  appendSeq: number;
}

interface EntryDoc {
  kind: 't5t';
  entryId: string;
  project: string;
  author: string;
  authorCanonical: string;
  date: string;
  items: string[];
  retracts: string | null;
  createdAt: string;
  appendSeq: number;
}

interface FeedbackDoc {
  kind: 'feedback';
  feedbackId: string;
  onEntry: string;
  from: string;
  fromCanonical: string;
  mentions: string[];
  comment: string;
  createdAt: string;
  appendSeq: number;
}

export interface AppendEntryInput {
  project: string;
  items: string[];
  date?: string;
  retracts?: string | null;
}

export interface AppendFeedbackInput {
  onEntry: string;
  comment: string;
  mentions?: string[];
}

export interface AppendGoalInput {
  project: string;
  text: string;
}

export interface AppendEvaluatorInput {
  project: string;
  evaluatorId: string;
  description: string;
  met?: boolean;
}

export interface AppendBottleneckInput {
  project: string;
  text?: string | null;
  clear?: boolean;
}

export interface AppendWipInput {
  project: string;
  evaluatorId: string;
  description: string;
  status?: WipStatus;
  wipId?: string;
}

export interface AppendTopFiveInput {
  project: string;
  text?: string;
  itemId?: string;
  status?: TopFiveStatus;
}

export interface PurgeSmokeProjectResult {
  slug: string;
  removed: {
    projects: number;
    entries: number;
    feedback: number;
    goals: number;
    evaluators: number;
    bottlenecks: number;
    wip: number;
    topfive: number;
    total: number;
  };
}

/**
 * Append-only T5T domain store over the in-process MemoryStore.
 *
 * Hard constraint (mirrors t5t-portal arch §1): no update / delete / replace
 * methods exist. Every state change is a new document. Latest-doc-wins is
 * computed at read time. If a caller wants to "edit" a goal, they append a
 * new Goal doc; the prior doc stays put.
 *
 * Storage layout: each doc kind lives in its own folder (UUIDs resolved at
 * boot by `loadT5tFolderIds`). Doc title = stable logical id per kind
 * (project=slug, goal=`${slug}-goal-<seq>`, evaluator=`${slug}-eval-<eid>-<seq>`,
 * bottleneck=`${slug}-bn-<seq>`, wip=`${slug}-wip-<seq>`,
 * entry=`<YYYY-MM-DD>-<author>-<seq>`, feedback=`${onEntry}-fb-<seq>`).
 * Doc content = JSON-encoded payload (kept simple — no YAML frontmatter
 * dependency in metabot-core).
 */
export class T5tStore {
  private memory: MemoryStore;
  private folderIds: T5tFolderIds;
  private logger: Logger;
  private appendCounter = 0;

  constructor(memory: MemoryStore, folderIds: T5tFolderIds, logger: Logger) {
    this.memory = memory;
    this.folderIds = folderIds;
    this.logger = logger;
  }

  // ---- read: projects ----

  listProjects(): ProjectSummary[] {
    const byProject = new Map<string, ProjectDoc>();
    for (const doc of this.loadDocs<ProjectDoc>(this.folderIds.projects, 'project')) {
      const cur = byProject.get(doc.payload.slug);
      if (!cur || isNewer(doc.payload, cur)) {
        byProject.set(doc.payload.slug, doc.payload);
      }
    }
    const summaries: ProjectSummary[] = [];
    for (const p of byProject.values()) summaries.push(this.enrichProject(p));
    summaries.sort((a, b) => a.slug.localeCompare(b.slug));
    return summaries;
  }

  getProject(slug: string): ProjectSummary | null {
    let latest: ProjectDoc | null = null;
    for (const doc of this.loadDocs<ProjectDoc>(this.folderIds.projects, 'project')) {
      if (doc.payload.slug !== slug) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
      }
    }
    return latest ? this.enrichProject(latest) : null;
  }

  private enrichProject(p: ProjectDoc): ProjectSummary {
    const goal = this.getLatestGoal(p.slug);
    const bn = this.getLatestBottleneck(p.slug);
    const evals = this.listEvaluators(p.slug);
    const lastEntry = this.latestEntryForProject(p.slug);
    return {
      slug: p.slug,
      name: p.name || p.slug,
      leaderEmail: p.leaderEmail ?? null,
      allowedUsers: p.allowedUsers || [],
      status: p.status || 'unknown',
      killCriteria: p.killCriteria ?? null,
      goal: goal ? goal.text : null,
      bottleneck: bn,
      evaluators: evals,
      lastPush: lastEntry ? lastEntry.createdAt : null,
      lastAuthor: lastEntry ? lastEntry.author : null,
    };
  }

  appendProject(input: ProjectCreateInput, cred: Credential): ProjectSummary {
    if (!input.slug) throw httpErr(400, 'slug_required');
    const createdAt = nowISO();
    const payload: ProjectDoc = {
      kind: 'project',
      slug: input.slug,
      name: input.name || input.slug,
      leaderEmail: input.leaderEmail ?? null,
      allowedUsers: input.allowedUsers || [],
      status: input.status || 'unknown',
      killCriteria: input.killCriteria ?? null,
      author: cred.botName,
      authorCanonical: cred.botName,
      createdAt,
      appendSeq: 0,
    };
    const seq = this.nextSeq(this.folderIds.projects, `${input.slug}-v`);
    const title = `${input.slug}-v${seq}`;
    this.createDoc(this.folderIds.projects, title, payload, [
      't5t-project', input.slug, cred.botName,
    ], cred);
    return this.getProject(input.slug)!;
  }

  /**
   * Mark a project as killed by appending a NEW project doc with
   * `status='killed'`, preserving all other fields. Append-only: the prior
   * doc stays for audit; latest-doc-wins surfaces the killed state at read.
   * Owner-auth is enforced at the route layer (`ownerGate`). Idempotent —
   * calling again on an already-killed project just appends another doc.
   */
  killProject(slug: string, cred: Credential): ProjectSummary {
    const cur = this.getProject(slug);
    if (!cur) throw httpErr(404, 'project_not_found');
    return this.appendProject(
      {
        slug: cur.slug,
        name: cur.name,
        leaderEmail: cur.leaderEmail,
        allowedUsers: cur.allowedUsers,
        status: 'killed',
        killCriteria: cur.killCriteria,
      },
      cred,
    );
  }

  /**
   * Reopen a killed project by appending a NEW project doc with status reset to
   * `unknown`. This preserves the append-only audit trail and all project
   * metadata; latest-doc-wins surfaces the reopened state.
   */
  reopenProject(slug: string, cred: Credential): ProjectSummary {
    const cur = this.getProject(slug);
    if (!cur) throw httpErr(404, 'project_not_found');
    return this.appendProject(
      {
        slug: cur.slug,
        name: cur.name,
        leaderEmail: cur.leaderEmail,
        allowedUsers: cur.allowedUsers,
        status: 'unknown',
        killCriteria: cur.killCriteria,
      },
      cred,
    );
  }

  /**
   * Hard-delete test projects only. T5T is append-only for real projects, but
   * smoke-test data creates noisy permanent board entries. Keep this escape
   * hatch tightly scoped to slugs that start with "smoke".
   */
  purgeSmokeProject(slug: string): PurgeSmokeProjectResult {
    const normalized = slug.trim();
    if (!normalized) throw httpErr(400, 'project_required');
    if (!normalized.toLowerCase().startsWith('smoke')) {
      throw httpErr(400, 'only_smoke_projects_can_be_deleted');
    }
    if (!this.getProject(normalized)) throw httpErr(404, 'project_not_found');

    const entryDocIds = new Set(
      this.loadDocs<EntryDoc>(this.folderIds.entries, 't5t')
        .filter((doc) => doc.payload.project === normalized)
        .map((doc) => doc.docId),
    );

    const removed = {
      projects: this.purgeDocs(this.folderIds.projects, 'project', (doc: ProjectDoc) => doc.slug === normalized),
      entries: this.purgeDocs(this.folderIds.entries, 't5t', (doc: EntryDoc) => doc.project === normalized),
      feedback: this.purgeDocs(this.folderIds.feedback, 'feedback', (doc: FeedbackDoc) => entryDocIds.has(doc.onEntry)),
      goals: this.purgeDocs(this.folderIds.goals, 'goal', (doc: GoalDoc) => doc.project === normalized),
      evaluators: this.purgeDocs(this.folderIds.evaluators, 'evaluator', (doc: EvaluatorDoc) => doc.project === normalized),
      bottlenecks: this.purgeDocs(this.folderIds.bottlenecks, 'bottleneck', (doc: BottleneckDoc) => doc.project === normalized),
      wip: this.purgeDocs(this.folderIds.wip, 'wip', (doc: WipDoc) => doc.project === normalized),
      topfive: this.purgeDocs(this.folderIds.topfive, 'topfive', (doc: TopFiveDoc) => doc.project === normalized),
      total: 0,
    };
    removed.total = Object.entries(removed)
      .filter(([key]) => key !== 'total')
      .reduce((sum, [, count]) => sum + count, 0);
    return { slug: normalized, removed };
  }

  // ---- read: goals ----

  getLatestGoal(slug: string): Goal | null {
    let latest: GoalDoc | null = null;
    let latestId = '';
    for (const doc of this.loadDocs<GoalDoc>(this.folderIds.goals, 'goal')) {
      if (doc.payload.project !== slug) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
        latestId = doc.docId;
      }
    }
    return latest ? goalDocToGoal(latest, latestId) : null;
  }

  appendGoal(input: AppendGoalInput, cred: Credential): Goal {
    if (!input.project || !input.text) throw httpErr(400, 'project_and_text_required');
    const prev = this.getLatestGoal(input.project);
    const seq = this.nextSeq(this.folderIds.goals, `${input.project}-goal-`);
    const goalId = `${input.project}-goal-${seq}`;
    const createdAt = nowISO();
    const payload: GoalDoc = {
      kind: 'goal',
      project: input.project,
      goalId,
      text: input.text,
      author: cred.botName,
      authorCanonical: cred.botName,
      replaces: prev ? prev.goalId : null,
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.goals, goalId, payload, [
      't5t-goal', input.project, cred.botName,
    ], cred);
    return goalDocToGoal(payload, docId);
  }

  // ---- read: evaluators ----

  listEvaluators(slug: string): Evaluator[] {
    const byEvalId = new Map<string, EvaluatorDoc & { docId: string }>();
    for (const doc of this.loadDocs<EvaluatorDoc>(this.folderIds.evaluators, 'evaluator')) {
      if (doc.payload.project !== slug) continue;
      const cur = byEvalId.get(doc.payload.evaluatorId);
      if (!cur || isNewer(doc.payload, cur)) {
        byEvalId.set(doc.payload.evaluatorId, { ...doc.payload, docId: doc.docId });
      }
    }
    const out = [...byEvalId.values()].map((d) => evaluatorDocToEvaluator(d, d.docId));
    out.sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId));
    return out;
  }

  appendEvaluator(input: AppendEvaluatorInput, cred: Credential): Evaluator {
    if (!input.project || !input.evaluatorId) {
      throw httpErr(400, 'project_and_evaluator_id_required');
    }
    const all = this.listEvaluators(input.project);
    const prev = all.find((e) => e.evaluatorId === input.evaluatorId) || null;
    let description = input.description;
    if (!description || !description.trim()) {
      if (!prev) throw httpErr(400, 'description_required_for_new_evaluator');
      description = prev.description;
    }
    const seq = prev ? prev.seq + 1 : 1;
    const title = `${input.project}-eval-${input.evaluatorId}-${seq}`;
    const createdAt = nowISO();
    const payload: EvaluatorDoc = {
      kind: 'evaluator',
      project: input.project,
      evaluatorId: input.evaluatorId,
      description,
      met: input.met === true,
      seq,
      author: cred.botName,
      authorCanonical: cred.botName,
      replaces: prev ? prev.docId : null,
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.evaluators, title, payload, [
      't5t-evaluator', input.project, input.evaluatorId, cred.botName,
    ], cred);
    return evaluatorDocToEvaluator(payload, docId);
  }

  // ---- read: bottlenecks ----

  getLatestBottleneck(slug: string): Bottleneck | null {
    let latest: BottleneckDoc | null = null;
    let latestId = '';
    for (const doc of this.loadDocs<BottleneckDoc>(this.folderIds.bottlenecks, 'bottleneck')) {
      if (doc.payload.project !== slug) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
        latestId = doc.docId;
      }
    }
    if (!latest || latest.cleared) return null;
    return bottleneckDocToBottleneck(latest, latestId);
  }

  appendBottleneck(input: AppendBottleneckInput, cred: Credential): Bottleneck {
    if (!input.project) throw httpErr(400, 'project_required');
    const seq = this.nextSeq(this.folderIds.bottlenecks, `${input.project}-bn-`);
    const bnId = `${input.project}-bn-${seq}`;
    const clear = input.clear === true;
    const text = clear ? (input.text || '(cleared)') : (input.text || '').trim();
    if (!clear && !text) throw httpErr(400, 'text_required_when_not_clearing');
    const createdAt = nowISO();
    // For "replaces" we want the prior doc's id; latest may or may not be
    // cleared, both count as the prior link target. Look up across all.
    const prior = this.findLatestBottleneckIncludingCleared(input.project);
    const payload: BottleneckDoc = {
      kind: 'bottleneck',
      project: input.project,
      bottleneckId: bnId,
      text,
      cleared: clear,
      author: cred.botName,
      authorCanonical: cred.botName,
      replaces: prior ? prior.bottleneckId : null,
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.bottlenecks, bnId, payload, [
      't5t-bottleneck', input.project, cred.botName,
    ], cred);
    return bottleneckDocToBottleneck(payload, docId);
  }

  private findLatestBottleneckIncludingCleared(slug: string): Bottleneck | null {
    let latest: BottleneckDoc | null = null;
    let latestId = '';
    for (const doc of this.loadDocs<BottleneckDoc>(this.folderIds.bottlenecks, 'bottleneck')) {
      if (doc.payload.project !== slug) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
        latestId = doc.docId;
      }
    }
    return latest ? bottleneckDocToBottleneck(latest, latestId) : null;
  }

  // ---- read: wip ----

  listWipItems(slug: string): WIPItem[] {
    const byWipId = new Map<string, WipDoc & { docId: string }>();
    for (const doc of this.loadDocs<WipDoc>(this.folderIds.wip, 'wip')) {
      if (doc.payload.project !== slug) continue;
      const cur = byWipId.get(doc.payload.wipId);
      if (!cur || isNewer(doc.payload, cur)) {
        byWipId.set(doc.payload.wipId, { ...doc.payload, docId: doc.docId });
      }
    }
    const docs = [...byWipId.values()];
    const statusOrder: Record<WipStatus, number> = { doing: 0, queued: 1, done: 2 };
    docs.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 9;
      const sb = statusOrder[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.appendSeq - a.appendSeq;
    });
    return docs.map((d) => wipDocToWip(d, d.docId));
  }

  getWipById(wipId: string): WIPItem | null {
    let latest: WipDoc | null = null;
    let latestId = '';
    for (const doc of this.loadDocs<WipDoc>(this.folderIds.wip, 'wip')) {
      if (doc.payload.wipId !== wipId) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
        latestId = doc.docId;
      }
    }
    return latest ? wipDocToWip(latest, latestId) : null;
  }

  appendWipItem(input: AppendWipInput, cred: Credential): WIPItem {
    if (!input.project || !input.evaluatorId || !input.description) {
      throw httpErr(400, 'project_evaluator_id_and_description_required');
    }
    const status: WipStatus = input.status || 'queued';
    if (!['queued', 'doing', 'done'].includes(status)) {
      throw httpErr(400, 'invalid_wip_status');
    }
    const createdAt = nowISO();
    let finalId: string;
    let targetProject: string;
    let targetEvaluator: string;
    let replaces: string | null;
    if (input.wipId) {
      const prev = this.getWipById(input.wipId);
      if (!prev) throw httpErr(404, 'wip_not_found');
      // Guard against cross-project mutation via a guessable wipId: the
      // caller's project must match the item being transitioned.
      if (prev.project !== input.project) throw httpErr(404, 'wip_not_found');
      // Transitions can't move columns; lock to the original.
      finalId = input.wipId;
      targetProject = prev.project;
      targetEvaluator = prev.evaluatorId;
      replaces = prev.docId;
    } else {
      const seq = this.nextSeq(this.folderIds.wip, `${input.project}-wip-`);
      finalId = `${input.project}-wip-${seq}`;
      targetProject = input.project;
      targetEvaluator = input.evaluatorId;
      replaces = null;
    }
    // The doc title must be unique — for transitions, append a per-call suffix
    // so the slug collision check in MemoryStore doesn't reject the new doc.
    const title = `${finalId}-t${shortStamp()}`;
    const payload: WipDoc = {
      kind: 'wip',
      project: targetProject,
      evaluatorId: targetEvaluator,
      wipId: finalId,
      description: input.description,
      status,
      author: cred.botName,
      authorCanonical: cred.botName,
      replaces,
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.wip, title, payload, [
      't5t-wip', targetProject, targetEvaluator, cred.botName,
    ], cred);
    return wipDocToWip(payload, docId);
  }

  computeWipBoard(slug: string): WIPBoardColumn[] {
    const evals = this.listEvaluators(slug);
    const items = this.listWipItems(slug);
    return evals.map((ev) => ({
      evaluator: ev,
      items: items.filter((w) => w.evaluatorId === ev.evaluatorId),
    }));
  }

  // ---- read: top-five ----

  listTopFiveItems(slug: string): TopFiveItem[] {
    const byItemId = new Map<string, TopFiveDoc & { docId: string }>();
    for (const doc of this.loadDocs<TopFiveDoc>(this.folderIds.topfive, 'topfive')) {
      if (doc.payload.project !== slug) continue;
      const cur = byItemId.get(doc.payload.itemId);
      if (!cur || isNewer(doc.payload, cur)) {
        byItemId.set(doc.payload.itemId, { ...doc.payload, docId: doc.docId });
      }
    }
    const docs = [...byItemId.values()].filter((d) => d.status !== 'removed');
    const statusOrder: Record<TopFiveStatus, number> = { open: 0, done: 1, removed: 2 };
    docs.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 9;
      const sb = statusOrder[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.appendSeq - a.appendSeq;
    });
    return docs.map((d) => topFiveDocToTopFive(d, d.docId));
  }

  getTopFiveById(itemId: string): TopFiveItem | null {
    let latest: TopFiveDoc | null = null;
    let latestId = '';
    for (const doc of this.loadDocs<TopFiveDoc>(this.folderIds.topfive, 'topfive')) {
      if (doc.payload.itemId !== itemId) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
        latestId = doc.docId;
      }
    }
    return latest ? topFiveDocToTopFive(latest, latestId) : null;
  }

  appendTopFive(input: AppendTopFiveInput, cred: Credential): TopFiveItem {
    if (!input.project) throw httpErr(400, 'project_required');
    const status: TopFiveStatus = input.status || 'open';
    if (!['open', 'done', 'removed'].includes(status)) {
      throw httpErr(400, 'invalid_topfive_status');
    }
    const createdAt = nowISO();
    let finalId: string;
    let targetProject: string;
    let replaces: string | null;
    let text: string;
    if (input.itemId) {
      const prev = this.getTopFiveById(input.itemId);
      if (!prev) throw httpErr(404, 'topfive_not_found');
      // Guard against cross-project mutation via a guessable itemId.
      if (prev.project !== input.project) throw httpErr(404, 'topfive_not_found');
      finalId = input.itemId;
      targetProject = prev.project;
      replaces = prev.docId;
      text = (input.text ?? '').trim() || prev.text;
    } else {
      const trimmed = (input.text ?? '').trim();
      if (!trimmed) throw httpErr(400, 'text_required');
      const seq = this.nextSeq(this.folderIds.topfive, `${input.project}-tf-`);
      finalId = `${input.project}-tf-${seq}`;
      targetProject = input.project;
      replaces = null;
      text = trimmed;
    }
    const title = input.itemId ? `${finalId}-t${shortStamp()}` : finalId;
    const payload: TopFiveDoc = {
      kind: 'topfive',
      project: targetProject,
      itemId: finalId,
      text,
      status,
      author: cred.botName,
      authorCanonical: cred.botName,
      replaces,
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.topfive, title, payload, [
      't5t-topfive', targetProject, cred.botName,
    ], cred);
    return topFiveDocToTopFive(payload, docId);
  }

  // ---- read: entries ----

  listEntriesByProject(slug: string): T5TEntry[] {
    const out: { entry: T5TEntry; appendSeq: number }[] = [];
    for (const doc of this.loadDocs<EntryDoc>(this.folderIds.entries, 't5t')) {
      if (doc.payload.project !== slug) continue;
      out.push({
        entry: entryDocToEntry(doc.payload, doc.docId),
        appendSeq: doc.payload.appendSeq ?? 0,
      });
    }
    out.sort((a, b) => {
      if (a.entry.createdAt !== b.entry.createdAt) {
        return b.entry.createdAt.localeCompare(a.entry.createdAt);
      }
      return b.appendSeq - a.appendSeq;
    });
    return out.map((x) => x.entry);
  }

  recentEntries(limit: number): T5TEntry[] {
    const all: { entry: T5TEntry; appendSeq: number }[] = [];
    for (const doc of this.loadDocs<EntryDoc>(this.folderIds.entries, 't5t')) {
      all.push({
        entry: entryDocToEntry(doc.payload, doc.docId),
        appendSeq: doc.payload.appendSeq ?? 0,
      });
    }
    all.sort((a, b) => {
      if (a.entry.createdAt !== b.entry.createdAt) {
        return b.entry.createdAt.localeCompare(a.entry.createdAt);
      }
      return b.appendSeq - a.appendSeq;
    });
    return all.slice(0, Math.max(0, limit)).map((x) => x.entry);
  }

  appendEntry(input: AppendEntryInput, cred: Credential): T5TEntry {
    if (!input.project) throw httpErr(400, 'project_required');
    const items = (input.items || []).map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) throw httpErr(400, 'items_required');
    const dateStr = (input.date || todayISODate()).slice(0, 10);
    const author = cred.botName || 'web';
    const seq = this.nextEntrySeq(dateStr, author);
    const entryId = `${dateStr}-${author}-${pad3(seq)}`;
    const createdAt = nowISO();
    const payload: EntryDoc = {
      kind: 't5t',
      entryId,
      project: input.project,
      author,
      authorCanonical: cred.botName,
      date: dateStr,
      items,
      retracts: input.retracts ?? null,
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.entries, entryId, payload, [
      't5t', input.project, author,
    ], cred);
    return entryDocToEntry(payload, docId);
  }

  // ---- read: feedback ----

  listFeedbackForEntry(entryDocId: string): FeedbackEntry[] {
    // Threaded UX shape — feedback under an entry is rendered oldest-first.
    // Use (createdAt, appendSeq) ascending so two appends in the same ms
    // stay in insertion order; the loadDocs iteration order is unspecified
    // and would otherwise be flaky under CI load.
    const out: { entry: FeedbackEntry; appendSeq: number }[] = [];
    for (const doc of this.loadDocs<FeedbackDoc>(this.folderIds.feedback, 'feedback')) {
      if (doc.payload.onEntry !== entryDocId) continue;
      out.push({
        entry: feedbackDocToFeedback(doc.payload, doc.docId),
        appendSeq: doc.payload.appendSeq ?? 0,
      });
    }
    out.sort((a, b) => {
      if (a.entry.createdAt !== b.entry.createdAt) {
        return a.entry.createdAt.localeCompare(b.entry.createdAt);
      }
      return a.appendSeq - b.appendSeq;
    });
    return out.map((x) => x.entry);
  }

  listAllFeedback(): FeedbackEntry[] {
    const out: FeedbackEntry[] = [];
    for (const doc of this.loadDocs<FeedbackDoc>(this.folderIds.feedback, 'feedback')) {
      out.push(feedbackDocToFeedback(doc.payload, doc.docId));
    }
    return out;
  }

  appendFeedback(input: AppendFeedbackInput, cred: Credential): FeedbackEntry {
    if (!input.onEntry || !input.comment) {
      throw httpErr(400, 'on_entry_and_comment_required');
    }
    const seq = this.nextFeedbackSeq(input.onEntry);
    const feedbackId = `${input.onEntry}-fb-${pad3(seq)}`;
    const createdAt = nowISO();
    const payload: FeedbackDoc = {
      kind: 'feedback',
      feedbackId,
      onEntry: input.onEntry,
      from: cred.botName,
      fromCanonical: cred.botName,
      mentions: input.mentions || [],
      comment: input.comment.trim(),
      createdAt,
      appendSeq: 0,
    };
    const docId = this.createDoc(this.folderIds.feedback, feedbackId, payload, [
      't5t-feedback', input.onEntry, cred.botName,
    ], cred);
    return feedbackDocToFeedback(payload, docId);
  }

  // ---- anomalies ----

  computeAnomalies(now: Date = new Date()): AnomalyItem[] {
    const projects = this.listProjects();
    const out: AnomalyItem[] = [];
    for (const proj of projects) {
      if (!proj.leaderEmail) {
        out.push({
          project: proj.slug,
          reason: 'no_owner',
          detail: 'no leader assigned',
          lastPush: proj.lastPush,
        });
      }
      if (proj.status === 'red') {
        out.push({
          project: proj.slug,
          reason: 'kill_red',
          detail: proj.killCriteria || 'status=red',
          lastPush: proj.lastPush,
        });
      }
      if (proj.lastPush == null) {
        out.push({
          project: proj.slug,
          reason: 'stale',
          detail: 'never pushed',
          lastPush: null,
        });
      } else {
        const ageDays = Math.floor((now.getTime() - Date.parse(proj.lastPush)) / 86_400_000);
        if (ageDays > STALE_DAYS) {
          out.push({
            project: proj.slug,
            reason: 'stale',
            detail: `last push ${ageDays} days ago`,
            lastPush: proj.lastPush,
          });
        }
      }

      // no_goal — fires when no goal AND 24h grace from project createdAt expired.
      if (!proj.goal) {
        const projCreated = this.getProjectCreatedAt(proj.slug);
        const withinGrace = projCreated !== null
          && (now.getTime() - Date.parse(projCreated)) <= NO_GOAL_GRACE_HOURS * 3600 * 1000;
        if (!withinGrace) {
          out.push({
            project: proj.slug,
            reason: 'no_goal',
            detail: 'no goal declared (24h grace)',
            lastPush: proj.lastPush,
          });
        }
      }

      // Derived-only governance signal: a newly-created project gets the same
      // 24-hour initialization grace as the no-goal check.
      if (proj.evaluators.length === 0) {
        const projCreated = this.getProjectCreatedAt(proj.slug);
        const withinGrace = projCreated !== null
          && (now.getTime() - Date.parse(projCreated)) <= NO_GOAL_GRACE_HOURS * 3600 * 1000;
        if (!withinGrace) {
          out.push({
            project: proj.slug,
            reason: 'no_evaluator',
            detail: 'no evaluator declared (24h grace)',
            lastPush: proj.lastPush,
          });
        }
      }

      // stale_bottleneck — WIP queued/doing exists for > N days AND no active bottleneck.
      if (proj.bottleneck === null) {
        const wips = this.listWipItems(proj.slug);
        let oldestInFlight: string | null = null;
        for (const w of wips) {
          if (w.status === 'queued' || w.status === 'doing') {
            if (oldestInFlight == null || w.createdAt < oldestInFlight) {
              oldestInFlight = w.createdAt;
            }
          }
        }
        if (oldestInFlight !== null) {
          const days = Math.floor((now.getTime() - Date.parse(oldestInFlight)) / 86_400_000);
          if (days > STALE_BOTTLENECK_DAYS) {
            out.push({
              project: proj.slug,
              reason: 'stale_bottleneck',
              detail: `WIP in flight but no current bottleneck for ${days}d`,
              lastPush: proj.lastPush,
            });
          }
        }
      }
    }
    return out;
  }

  // ---- internals ----

  private getProjectCreatedAt(slug: string): string | null {
    let earliest: { createdAt: string; appendSeq: number } | null = null;
    for (const doc of this.loadDocs<ProjectDoc>(this.folderIds.projects, 'project')) {
      if (doc.payload.slug !== slug) continue;
      if (earliest === null || isNewer(earliest, doc.payload)) {
        earliest = { createdAt: doc.payload.createdAt, appendSeq: doc.payload.appendSeq };
      }
    }
    return earliest ? earliest.createdAt : null;
  }

  private latestEntryForProject(slug: string): EntryDoc | null {
    let latest: EntryDoc | null = null;
    for (const doc of this.loadDocs<EntryDoc>(this.folderIds.entries, 't5t')) {
      if (doc.payload.project !== slug) continue;
      if (!latest || isNewer(doc.payload, latest)) {
        latest = doc.payload;
      }
    }
    return latest;
  }

  /**
   * List every doc in a folder, parsing payload JSON. Drops malformed rows
   * with a debug log (a malformed doc in a t5t folder is unusual but not a
   * fatal error — recovery path: re-append).
   */
  private loadDocs<T extends { kind: string }>(
    folderId: string,
    kind: T['kind'],
  ): { docId: string; payload: T }[] {
    const summaries = this.memory.listDocuments({ folder_id: folderId, limit: 500 }, ADMIN_READ_CRED);
    const out: { docId: string; payload: T }[] = [];
    for (const s of summaries) {
      const doc = this.memory.getDocument(s.id, ADMIN_READ_CRED);
      if (!doc) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(doc.content);
      } catch {
        this.logger.debug({ docId: doc.id, path: doc.path }, 't5t doc payload not JSON');
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const obj = parsed as { kind?: string };
      if (obj.kind !== kind) continue;
      out.push({ docId: doc.id, payload: parsed as T });
    }
    return out;
  }

  private createDoc(
    folderId: string,
    title: string,
    payload: { appendSeq: number },
    tags: string[],
    cred: Credential,
  ): string {
    const folder = this.memory.findFolderById(folderId);
    if (!folder) throw httpErr(500, 't5t_folder_missing');
    // Stamp a process-monotonic appendSeq into the payload so latest-doc-wins
    // ordering stays deterministic when two appends land in the same millisecond
    // (createdAt-only comparison ties otherwise, observed under test load).
    this.appendCounter += 1;
    payload.appendSeq = this.appendCounter;
    // Use admin-elevated write so per-cred ACL doesn't block t5t writes
    // against the /t5t/* namespace. The caller's identity is preserved in
    // the payload's `author` / `authorCanonical` fields and in audit-log.
    const writeCred: Credential = {
      ...ADMIN_READ_CRED,
      botName: cred.botName,
    };
    const doc = this.memory.createDocument({
      title,
      folder_id: folderId,
      content: JSON.stringify(payload),
      content_type: 'text/markdown',
      tags,
      created_by: cred.botName,
    }, writeCred);
    return doc.id;
  }

  private purgeDocs<T extends { kind: string }>(
    folderId: string,
    kind: T['kind'],
    predicate: (payload: T) => boolean,
  ): number {
    let removed = 0;
    for (const doc of this.loadDocs<T>(folderId, kind)) {
      if (!predicate(doc.payload)) continue;
      if (this.memory.deleteDocument(doc.docId, ADMIN_READ_CRED)) {
        removed += 1;
      }
    }
    return removed;
  }

  private nextSeq(folderId: string, titlePrefix: string): number {
    // Cheap pass: list summaries (no body load) and find the highest tail seq.
    const summaries = this.memory.listDocuments({ folder_id: folderId, limit: 500 }, ADMIN_READ_CRED);
    let max = 0;
    for (const s of summaries) {
      if (!s.title.startsWith(titlePrefix)) continue;
      const tail = s.title.slice(titlePrefix.length);
      const num = parseInt(tail, 10);
      if (Number.isFinite(num) && num > max) max = num;
    }
    return max + 1;
  }

  private nextEntrySeq(date: string, author: string): number {
    const prefix = `${date}-${author}-`;
    const summaries = this.memory.listDocuments(
      { folder_id: this.folderIds.entries, limit: 500 }, ADMIN_READ_CRED,
    );
    let max = 0;
    for (const s of summaries) {
      if (!s.title.startsWith(prefix)) continue;
      const tail = s.title.slice(prefix.length);
      const num = parseInt(tail, 10);
      if (Number.isFinite(num) && num > max) max = num;
    }
    return max + 1;
  }

  private nextFeedbackSeq(onEntry: string): number {
    const prefix = `${onEntry}-fb-`;
    const summaries = this.memory.listDocuments(
      { folder_id: this.folderIds.feedback, limit: 500 }, ADMIN_READ_CRED,
    );
    let max = 0;
    for (const s of summaries) {
      if (!s.title.startsWith(prefix)) continue;
      const tail = s.title.slice(prefix.length);
      const num = parseInt(tail, 10);
      if (Number.isFinite(num) && num > max) max = num;
    }
    return max + 1;
  }
}

// ---- helpers (file-local; not exported) ----

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Latest-doc-wins comparator: `cand` is "newer than" `cur` iff its
 * `(createdAt, appendSeq)` tuple is strictly greater. `appendSeq` is the
 * process-monotonic counter stamped by `createDoc()`; it breaks ties when
 * two appends land in the same millisecond (otherwise `createdAt` strings
 * compare equal and the first-inserted doc wrongly stays "latest").
 */
function isNewer(
  cand: { createdAt: string; appendSeq: number },
  cur: { createdAt: string; appendSeq: number },
): boolean {
  if (cand.createdAt !== cur.createdAt) return cand.createdAt > cur.createdAt;
  return cand.appendSeq > cur.appendSeq;
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}

function shortStamp(): string {
  return Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}

function httpErr(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * A synthetic admin cred used internally by T5tStore for MemoryStore calls
 * against the `/t5t/*` namespace. It's never returned anywhere and never
 * audited — owner-auth happens at the t5t route layer using the real caller's
 * cred, which is what's persisted into each doc's `author` field.
 */
const ADMIN_READ_CRED: Credential = {
  id: 't5t-store-internal',
  tokenHash: '',
  botName: 't5t-store',
  ownerName: 't5t-store',
  role: 'admin',
  writableNamespaces: [],
  readableNamespaces: [],
  publishSkill: false,
  createdAt: 0,
  revokedAt: null,
  lastUsedAt: null,
  notes: '',
};

function goalDocToGoal(d: GoalDoc, docId: string): Goal {
  return {
    project: d.project,
    goalId: d.goalId,
    text: d.text,
    author: d.author,
    authorCanonical: d.authorCanonical,
    replaces: d.replaces ?? null,
    createdAt: d.createdAt,
    docId,
  };
}

function evaluatorDocToEvaluator(d: EvaluatorDoc, docId: string): Evaluator {
  return {
    project: d.project,
    evaluatorId: d.evaluatorId,
    description: d.description,
    met: d.met,
    seq: d.seq,
    author: d.author,
    authorCanonical: d.authorCanonical,
    createdAt: d.createdAt,
    docId,
  };
}

function bottleneckDocToBottleneck(d: BottleneckDoc, docId: string): Bottleneck {
  return {
    project: d.project,
    bottleneckId: d.bottleneckId,
    text: d.text,
    cleared: d.cleared,
    author: d.author,
    authorCanonical: d.authorCanonical,
    replaces: d.replaces ?? null,
    createdAt: d.createdAt,
    docId,
  };
}

function wipDocToWip(d: WipDoc, docId: string): WIPItem {
  return {
    project: d.project,
    evaluatorId: d.evaluatorId,
    wipId: d.wipId,
    description: d.description,
    status: d.status,
    author: d.author,
    authorCanonical: d.authorCanonical,
    replaces: d.replaces ?? null,
    createdAt: d.createdAt,
    docId,
  };
}

function topFiveDocToTopFive(d: TopFiveDoc, docId: string): TopFiveItem {
  return {
    project: d.project,
    itemId: d.itemId,
    text: d.text,
    status: d.status,
    author: d.author,
    authorCanonical: d.authorCanonical,
    replaces: d.replaces ?? null,
    createdAt: d.createdAt,
    docId,
  };
}

function entryDocToEntry(d: EntryDoc, docId: string): T5TEntry {
  return {
    entryId: d.entryId,
    docId,
    author: d.author,
    authorCanonical: d.authorCanonical,
    project: d.project,
    date: d.date,
    items: d.items,
    retracts: d.retracts ?? null,
    createdAt: d.createdAt,
  };
}

function feedbackDocToFeedback(d: FeedbackDoc, docId: string): FeedbackEntry {
  return {
    feedbackId: d.feedbackId,
    docId,
    onEntry: d.onEntry,
    from: d.from,
    fromCanonical: d.fromCanonical,
    mentions: d.mentions || [],
    comment: d.comment,
    createdAt: d.createdAt,
  };
}
