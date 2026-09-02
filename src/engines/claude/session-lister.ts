/**
 * Claude session lister — read-only fs helper for the Feishu `/resume` command.
 *
 * Enumerates the `.jsonl` session transcripts that the interactive `claude`
 * backend writes under `~/.claude/projects/<escaped-cwd>/`, and extracts a
 * short preview (the first real user prompt) plus last-active time for each.
 *
 * Functional style, mirrors `pty/jsonl-scanner.ts`. No external deps, no
 * mutation — safe to call from a command handler on every `/resume`.
 */

import { openSync, readSync, statSync, closeSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SessionSummary {
  sessionId: string;
  /** First real user prompt, whitespace-collapsed + truncated. */
  preview: string;
  /** Last-modified time of the .jsonl (ms since epoch). */
  lastActive: number;
  sizeBytes: number;
  /** True when this is the chat's currently-pinned session. */
  isCurrent: boolean;
}

/**
 * Directory where `claude` stores this cwd's session transcripts.
 *
 * MUST match what claude itself does: EVERY non-alphanumeric char (not just
 * '/', but also '_', '.', spaces, CJK brackets…) becomes '-'. Verified against
 * live ~/.claude/projects: /u/openclaw_workspace → -u-openclaw-workspace,
 * ~/.openclaw → --openclaw. Replacing only '/' breaks any cwd containing '_'.
 * Exported so tests share one source of truth with the path derivation under test.
 */
export function claudeProjectsDir(cwd: string, homeDir: string = os.homedir()): string {
  const escaped = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(homeDir, '.claude', 'projects', escaped);
}

/** Read just enough of a .jsonl to extract the first real user prompt. */
function readSessionPreview(filePath: string, previewMaxLen: number): string {
  const CHUNK = 64 * 1024;
  let fd: number | undefined;
  let buffered = '';
  let offset = 0;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(CHUNK);
    // Read in chunks; stop as soon as we find the first usable user prompt.
    // Most sessions yield it inside the first chunk, so we rarely loop.
    // Cap total scan to ~512 KiB to avoid pathological full-file reads.
    let scanned = 0;
    while (scanned < 8 * CHUNK) {
      const bytes = readSync(fd, buf, 0, CHUNK, offset);
      if (bytes <= 0) break;
      offset += bytes;
      scanned += bytes;
      buffered += buf.toString('utf8', 0, bytes);

      const lines = buffered.split('\n');
      // Keep the last (possibly partial) line for the next iteration.
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const text = extractUserPromptText(trimmed);
        if (text) {
          const collapsed = text.replace(/\s+/g, ' ').trim();
          if (collapsed) {
            return collapsed.length > previewMaxLen
              ? collapsed.slice(0, previewMaxLen) + '…'
              : collapsed;
          }
        }
      }
      if (bytes < CHUNK) break; // reached EOF
    }
  } catch {
    // unreadable / disappeared mid-scan — fall through to empty preview
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return '';
}

/**
 * If a raw jsonl line is a `type:'user'` record carrying a plain-string
 * prompt (the initial user message), return that text. tool_result records
 * carry an array `content` → skipped. Malformed JSON → skipped.
 * Mirrors message-adapter.ts:96-108.
 */
function extractUserPromptText(line: string): string | undefined {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!rec || rec.type !== 'user') return undefined;
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  return undefined;
}

/**
 * List the recent Claude sessions for a working directory, newest first.
 * Returns `[]` if the projects dir is missing/unreadable.
 */
export function listClaudeSessions(opts: {
  workingDirectory: string;
  currentSessionId?: string;
  limit?: number;
  homeDir?: string;
  previewMaxLen?: number;
}): SessionSummary[] {
  const {
    workingDirectory,
    currentSessionId,
    limit = 10,
    homeDir = os.homedir(),
    previewMaxLen = 80,
  } = opts;

  const dir = claudeProjectsDir(workingDirectory, homeDir);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    summaries.push({
      sessionId,
      preview: '', // filled lazily below, only for the top `limit`
      lastActive: stat.mtimeMs,
      sizeBytes: stat.size,
      isCurrent: sessionId === currentSessionId,
    });
  }

  summaries.sort((a, b) => b.lastActive - a.lastActive);
  const top = summaries.slice(0, limit);

  // Only read previews for the sessions we'll actually display.
  for (const s of top) {
    const filePath = path.join(dir, `${s.sessionId}.jsonl`);
    s.preview = readSessionPreview(filePath, previewMaxLen) || '(no preview)';
  }

  return top;
}
