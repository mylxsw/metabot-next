import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config.js';

describe('Feishu/Lark domain configuration', () => {
  it.each(['array', 'object'])('preserves per-bot domains in the %s config format', (format) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-lark-config-'));
    const bots = [undefined, 'feishu', 'lark'].map((larkDomain, i) => ({
      name: `bot-${i}`, feishuAppId: 'test-app', feishuAppSecret: 'test-secret',
      defaultWorkingDirectory: directory, ...(larkDomain ? { larkDomain } : {}),
    }));
    const file = path.join(directory, 'bots.json');
    fs.writeFileSync(file, JSON.stringify(format === 'array' ? bots : { feishuBots: bots }));
    vi.stubEnv('BOTS_CONFIG', file);
    try {
      expect(loadAppConfig().feishuBots.map(bot => bot.feishu.domain)).toEqual([undefined, 'feishu', 'lark']);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
