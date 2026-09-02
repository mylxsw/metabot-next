import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadConfig, parseArgs, print } from '@xvirobotics/cli-core';

// Personal Edition default: local Core. Set METABOT_CORE_URL for a hosted
// Core chosen by the operator.
const DEFAULT_CORE_URL = 'http://localhost:9200';

interface CoreConfig {
  url: string;
  token: string;
}

function readTokenFile(): string {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.metabot-core', 'token'), 'utf8');
    return raw.split(/\r?\n/)[0]?.trim() || '';
  } catch {
    return '';
  }
}

function loadCoreConfig(): CoreConfig {
  const envUrl = (process.env.METABOT_CORE_URL || process.env.METABOT_CORE_AGENT_BUS_URL || '').trim();
  const envToken = (process.env.METABOT_CORE_TOKEN || '').trim();
  if (envUrl || envToken) {
    const token = envToken || readTokenFile();
    if (!token) {
      throw new Error(
        'no token configured - set METABOT_CORE_TOKEN env var, or write the token to ~/.metabot-core/token',
      );
    }
    return { url: (envUrl || DEFAULT_CORE_URL).replace(/\/+$/, ''), token };
  }
  const cfg = loadConfig();
  return { url: cfg.url, token: cfg.token };
}

async function coreRequest<T = unknown>(cfg: CoreConfig, body: unknown): Promise<T> {
  const res = await fetch(`${cfg.url}/api/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw */
    }
  }
  if (!res.ok) {
    const errMsg =
      typeof parsed === 'object' && parsed && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    throw new Error(`metabot-core POST /api/messages -> ${res.status}: ${errMsg}`);
  }
  return parsed as T;
}

export function usage(): string {
  return `metabot send - minimal durable Agent Bus message\n\nUsage:\n  metabot send <agentId> "<message>" [options]\n\nOptions:\n  --session <sessionId>                  Target an exact Agent Bus session.\n  --implicit                             Do not present the run in a chat.\n  --origin-chat <oc_...> --origin-bot <name>\n                                         Project progress to the origin chat.\n  --child-direct                         Present the run in the target Agent chat.\n  --reply-to <messageId>                 Attach an optional reply reference.\n  --sender-session <sessionId>            Identify the sender session.\n  --idempotency-key <key>                Deduplicate retries.\n\nThe target Agent and session are resolved by Core.\n`;
}

export async function run(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage());
    return;
  }
  const { positional, flags } = parseArgs(args);
  const agentId = positional[0];
  const message = positional[1];
  if (!agentId || !message) throw new Error('metabot send: <agentId> "<message>" required');

  const body: Record<string, unknown> = { agentId, message };
  const implicit = flags.implicit === true;
  const childDirect = flags['child-direct'] === true || flags.direct === true;
  const originChatId =
    typeof flags['origin-chat'] === 'string'
      ? flags['origin-chat'].trim()
      : (process.env.METABOT_ORIGIN_CHAT || '').trim();
  const originBotName =
    typeof flags['origin-bot'] === 'string'
      ? flags['origin-bot'].trim()
      : (process.env.METABOT_ORIGIN_BOT || '').trim();
  if (implicit) {
    body.presentationMode = 'implicit';
  } else if (!childDirect && originChatId && originBotName) {
    body.presentationMode = 'origin-proxy';
    body.originChatId = originChatId;
    body.originBotName = originBotName;
  }
  for (const [flag, field] of [
    ['session', 'sessionId'],
    ['reply-to', 'replyTo'],
    ['sender-session', 'senderSessionId'],
    ['idempotency-key', 'idempotencyKey'],
  ] as const) {
    if (typeof flags[flag] === 'string' && flags[flag].trim()) body[field] = flags[flag].trim();
  }
  print(await coreRequest(loadCoreConfig(), body));
}
