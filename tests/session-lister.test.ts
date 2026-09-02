import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  claudeProjectsDir,
  listClaudeSessions,
} from '../src/engines/claude/session-lister.js';
import { listCodexSessions } from '../src/engines/codex/session-lister.js';

/**
 * session-lister backs the Feishu `/resume` command. It reads the on-disk
 * `claude` session transcripts for a working directory and extracts a preview
 * + last-active time. The path derivation MUST stay byte-identical to
 * pty-session.ts, so claudeProjectsDir is exported and asserted here.
 */

const CWD = '/vepfs/users/floodsung/some-project';

let home: string;
let projDir: string;

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}
function assistantLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}
function toolResultUserLine(): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } });
}

function writeSession(id: string, lines: string[], mtimeSec: number): void {
  const file = path.join(projDir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-sessions-'));
  projDir = claudeProjectsDir(CWD, home);
  fs.mkdirSync(projDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('claudeProjectsDir', () => {
  it('escapes every slash to a dash (matches pty-session.ts)', () => {
    const dir = claudeProjectsDir('/a/b/c', '/home/u');
    expect(dir).toBe(path.join('/home/u', '.claude', 'projects', '-a-b-c'));
  });
  it('escapes underscores and dots to dashes (matches claude itself)', () => {
    // Verified against live ~/.claude/projects (Claude Code 2.1.x):
    // /Users/garfield/openclaw_workspace → -Users-garfield-openclaw-workspace
    expect(claudeProjectsDir('/u/openclaw_workspace', '/home/u')).toBe(
      path.join('/home/u', '.claude', 'projects', '-u-openclaw-workspace'),
    );
    // /Users/garfield/.openclaw → -Users-garfield--openclaw
    expect(claudeProjectsDir('/Users/garfield/.openclaw', '/home/u')).toBe(
      path.join('/home/u', '.claude', 'projects', '-Users-garfield--openclaw'),
    );
  });
  it('resolves relative cwd before escaping', () => {
    const dir = claudeProjectsDir('.', '/home/u');
    expect(dir.startsWith(path.join('/home/u', '.claude', 'projects', '-'))).toBe(true);
  });
});

describe('listClaudeSessions', () => {
  it('returns [] when the projects dir is missing', () => {
    const out = listClaudeSessions({ workingDirectory: '/nope/nowhere', homeDir: home });
    expect(out).toEqual([]);
  });

  it('sorts newest-first and extracts the first string user prompt as preview', () => {
    writeSession('aaaaaaaa-1111-1111-1111-111111111111', [userLine('older session prompt'), assistantLine('hi')], 1000);
    writeSession('bbbbbbbb-2222-2222-2222-222222222222', [userLine('newest session prompt'), assistantLine('yo')], 3000);
    writeSession('cccccccc-3333-3333-3333-333333333333', [userLine('middle session prompt')], 2000);

    const out = listClaudeSessions({ workingDirectory: CWD, homeDir: home });
    expect(out.map((s) => s.sessionId.slice(0, 8))).toEqual(['bbbbbbbb', 'cccccccc', 'aaaaaaaa']);
    expect(out[0].preview).toBe('newest session prompt');
    expect(out[2].preview).toBe('older session prompt');
  });

  it('skips tool_result (array-content) user records and finds the real prompt', () => {
    writeSession('dddddddd-4444-4444-4444-444444444444', [
      toolResultUserLine(),
      assistantLine('thinking'),
      userLine('the actual question'),
    ], 5000);
    const out = listClaudeSessions({ workingDirectory: CWD, homeDir: home });
    expect(out[0].preview).toBe('the actual question');
  });

  it('skips malformed JSON lines without throwing', () => {
    writeSession('eeeeeeee-5555-5555-5555-555555555555', ['{ not json', userLine('recovered prompt')], 6000);
    const out = listClaudeSessions({ workingDirectory: CWD, homeDir: home });
    expect(out[0].preview).toBe('recovered prompt');
  });

  it('collapses whitespace and truncates long previews with an ellipsis', () => {
    const long = 'word '.repeat(60).trim(); // ~299 chars
    writeSession('ffffffff-6666-6666-6666-666666666666', [userLine(`multi\n  line\t prompt ${long}`)], 7000);
    const out = listClaudeSessions({ workingDirectory: CWD, homeDir: home, previewMaxLen: 20 });
    expect(out[0].preview.length).toBe(21); // 20 + ellipsis
    expect(out[0].preview.endsWith('…')).toBe(true);
    expect(out[0].preview).not.toContain('\n');
  });

  it('falls back to (no preview) when no user prompt exists', () => {
    writeSession('11111111-7777-7777-7777-777777777777', [assistantLine('only assistant')], 8000);
    const out = listClaudeSessions({ workingDirectory: CWD, homeDir: home });
    expect(out[0].preview).toBe('(no preview)');
  });

  it('marks the current session via isCurrent', () => {
    writeSession('22222222-8888-8888-8888-888888888888', [userLine('a')], 9000);
    writeSession('33333333-9999-9999-9999-999999999999', [userLine('b')], 9500);
    const out = listClaudeSessions({
      workingDirectory: CWD,
      homeDir: home,
      currentSessionId: '22222222-8888-8888-8888-888888888888',
    });
    expect(out.find((s) => s.sessionId.startsWith('22222222'))?.isCurrent).toBe(true);
    expect(out.find((s) => s.sessionId.startsWith('33333333'))?.isCurrent).toBe(false);
  });

  it('honours the limit (newest N) and ignores non-jsonl files', () => {
    for (let i = 0; i < 5; i++) {
      writeSession(`0000000${i}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, [userLine(`prompt ${i}`)], 1000 + i);
    }
    fs.writeFileSync(path.join(projDir, 'notes.txt'), 'ignore me', 'utf-8');
    const out = listClaudeSessions({ workingDirectory: CWD, homeDir: home, limit: 2 });
    expect(out.length).toBe(2);
    // newest two: index 4 then 3
    expect(out[0].preview).toBe('prompt 4');
    expect(out[1].preview).toBe('prompt 3');
  });
});

describe('listCodexSessions', () => {
  it('reads cwd-filtered Codex threads from state_5.sqlite', () => {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const db = new Database(path.join(codexHome, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER,
        first_user_message TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT ''
      );
    `);
    const insert = db.prepare(`
      INSERT INTO threads
      (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, updated_at_ms, first_user_message, preview)
      VALUES (?, ?, ?, ?, 'vscode', 'openai', ?, ?, 'workspace-write', 'never', 0, ?, ?, ?)
    `);
    insert.run('codex-old', 'sessions/old.jsonl', 1, 1, CWD, 'old title', 1000, 'old prompt', '');
    insert.run('codex-new', 'sessions/new.jsonl', 2, 2, CWD, 'new title', 3000, 'new prompt', 'new preview');
    insert.run('codex-other', 'sessions/other.jsonl', 3, 3, '/other/project', 'other title', 4000, 'other prompt', '');
    db.close();

    const out = listCodexSessions({
      workingDirectory: CWD,
      homeDir: home,
      currentSessionId: 'codex-old',
    });

    expect(out.map((s) => s.sessionId)).toEqual(['codex-new', 'codex-old']);
    expect(out[0].preview).toBe('new preview');
    expect(out[1].preview).toBe('old prompt');
    expect(out[1].isCurrent).toBe(true);
  });
});
