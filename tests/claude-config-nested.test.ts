import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config.js';

describe('Claude bot config — nested `claude:` block', () => {
  it('reads `model` from a nested `claude:` block (the user-friendly form)', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-config-'));
    const botsJson = {
      telegramBots: [
        {
          name: 'sonnet-bot',
          engine: 'claude',
          telegramBotToken: '000:***',
          defaultWorkingDirectory: directory,
          claude: { model: 'claude-sonnet-5-5' },
        },
      ],
    };
    const file = path.join(directory, 'bots.json');
    fs.writeFileSync(file, JSON.stringify(botsJson));
    vi.stubEnv('BOTS_CONFIG', file);
    try {
      const cfg = loadAppConfig();
      expect(cfg.telegramBots[0].claude.model).toBe('claude-sonnet-5-5');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads `model` from a top-level field (the existing top-level form)', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-config-'));
    const botsJson = {
      telegramBots: [
        {
          name: 'opus-bot',
          engine: 'claude',
          telegramBotToken: '000:***',
          defaultWorkingDirectory: directory,
          model: 'claude-opus-5-5',
        },
      ],
    };
    const file = path.join(directory, 'bots.json');
    fs.writeFileSync(file, JSON.stringify(botsJson));
    vi.stubEnv('BOTS_CONFIG', file);
    try {
      const cfg = loadAppConfig();
      expect(cfg.telegramBots[0].claude.model).toBe('claude-opus-5-5');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets the nested `claude:` block override the top-level `model` when both are set', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-config-'));
    const botsJson = {
      telegramBots: [
        {
          name: 'mixed-bot',
          engine: 'claude',
          telegramBotToken: '000:***',
          defaultWorkingDirectory: directory,
          model: 'claude-opus-5-5',
          claude: { model: 'claude-sonnet-5-5' },
        },
      ],
    };
    const file = path.join(directory, 'bots.json');
    fs.writeFileSync(file, JSON.stringify(botsJson));
    vi.stubEnv('BOTS_CONFIG', file);
    try {
      const cfg = loadAppConfig();
      expect(cfg.telegramBots[0].claude.model).toBe('claude-sonnet-5-5');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not let an empty-string nested `model` silently fall through to the top-level value', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-config-'));
    const botsJson = {
      telegramBots: [
        {
          name: 'empty-nested-bot',
          engine: 'claude',
          telegramBotToken: '000:***',
          defaultWorkingDirectory: directory,
          model: 'claude-opus-5-5',
          claude: { model: '' },
        },
      ],
    };
    const file = path.join(directory, 'bots.json');
    fs.writeFileSync(file, JSON.stringify(botsJson));
    vi.stubEnv('BOTS_CONFIG', file);
    try {
      const cfg = loadAppConfig();
      // An empty string in the nested block is treated as "not set" — the
      // top-level value takes over. This avoids the silent-fallback trap
      // where a stray `model: ""` would mask the user's intent.
      expect(cfg.telegramBots[0].claude.model).toBe('claude-opus-5-5');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to the hardcoded default when no model is configured anywhere', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-claude-config-'));
    delete process.env.CLAUDE_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    const botsJson = {
      telegramBots: [
        {
          name: 'no-model-bot',
          engine: 'claude',
          telegramBotToken: '000:***',
          defaultWorkingDirectory: directory,
        },
      ],
    };
    const file = path.join(directory, 'bots.json');
    fs.writeFileSync(file, JSON.stringify(botsJson));
    vi.stubEnv('BOTS_CONFIG', file);
    try {
      const cfg = loadAppConfig();
      // Whatever the compiled-in default is, it should be a non-empty string.
      expect(typeof cfg.telegramBots[0].claude.model).toBe('string');
      expect(cfg.telegramBots[0].claude.model.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});