/**
 * `metabot agents` subcommands.
 *
 *   metabot agents list [--include-hidden]
 *   metabot agents register --url <url> [--bot-name <name>] [--description <text>] [--hidden]
 *   metabot agents heartbeat [--bot-name <name>]
 *   metabot agents whoami
 *   metabot agents visible <botName>
 *   metabot agents hide    <botName>
 *   metabot agents remove  <botName>
 *
 * Wire shapes match `packages/server/src/agents/agent-routes.ts`. Use the
 * top-level `metabot send` command for Agent Bus communication.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs, print, loadConfig } from '@xvirobotics/cli-core';

// Personal Edition stays self-hostable: point at a local Core by default and
// let METABOT_CORE_URL opt into a user's own hosted Core.
const DEFAULT_BUS_URL = 'http://localhost:9200';

interface BusConfig {
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

function loadBusConfig(): BusConfig {
  const env = process.env;
  const overrideUrl = (env.METABOT_CORE_AGENT_BUS_URL || '').trim();
  if (overrideUrl) {
    const token = (env.METABOT_CORE_TOKEN || '').trim() || readTokenFile();
    if (!token) {
      throw new Error(
        'no token configured — set METABOT_CORE_TOKEN env var, or write the token to ~/.metabot-core/token',
      );
    }
    return { url: overrideUrl.replace(/\/+$/, ''), token };
  }
  const cfg = loadConfig();
  return { url: cfg.url, token: cfg.token };
}

async function busRequest<T = unknown>(
  cfg: BusConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + apiPath, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave raw
    }
  }
  if (!res.ok) {
    const errMsg =
      typeof parsed === 'object' && parsed && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    throw new Error(`metabot-core ${method} ${apiPath} → ${res.status}: ${errMsg}`);
  }
  return parsed as T;
}

interface AgentRow {
  botName: string;
  url: string;
  description?: string;
  visible: boolean;
  visibleToOwners?: string[];
  lastSeenAt: string;
}

interface ListResponse {
  agents: AgentRow[];
}

function usage(): string {
  return `metabot agents — central agent registry (the "address book" for peer bots)

Use metabot send <agentId> "<message>" for Agent Bus communication.

Subcommands:
  list [--include-hidden]               List visible agents (admin: --include-hidden shows all)
  search "<keyword>" [--limit 20 --offset 0]
  search --user <username> [--limit 20 --offset 0]
                                        Search agents with bounded pagination.
  register --url <url> [--bot-name <name>] [--description <text>] [--hidden]
                                        Register a bot in the registry; --bot-name
                                        lets one credential own many bots (anti-squat
                                        is enforced server-side by ownerCredentialId).
  heartbeat [--bot-name <name>]         Bump last_seen_at. Without --bot-name uses the
                                        caller's credential botName (legacy 1:1 mode).
  whoami                                Show the credential identity behind this token
                                        (botName, role, authSource).
  show    <agentId> --sessions          List up to 20 sessions for an agent
  visible <botName>                     Mark <botName> visible (must own or be admin)
  hide    <botName>                     Mark <botName> hidden  (must own or be admin)
  remove  <botName>                     Delete a registry row (must own or be admin)
  delete  <botName>                     Alias for remove
  share   <botName> <ownerName>         Add <ownerName> to <botName>'s per-user allowlist.
                                        Only takes effect when the bot is hidden.
  unshare <botName> <ownerName>         Remove <ownerName> from the allowlist.
  shared  <botName>                     Print <botName>'s current allowlist.

Env:
  METABOT_CORE_URL              memory + agents URL (default ${DEFAULT_BUS_URL})
  METABOT_CORE_AGENT_BUS_URL    override agents-only base URL (falls back to METABOT_CORE_URL)
  METABOT_CORE_TOKEN            bearer token (or ~/.metabot-core/token)

`;
}

async function cmdList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cfg = loadBusConfig();
  const includeHidden = flags['include-hidden'] === true || flags['include-hidden'] === 'true';
  const apiPath = includeHidden ? '/api/agents?includeHidden=1' : '/api/agents';
  const resp = await busRequest<ListResponse>(cfg, 'GET', apiPath);
  print(resp);
}

async function cmdSearch(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const term = positional[0] || (typeof flags.q === 'string' ? flags.q : '');
  const user = typeof flags.user === 'string' ? flags.user : '';
  if (!term && !user) throw new Error('metabot agents search: "<keyword>" or --user <username> required');
  const limit = typeof flags.limit === 'string' ? flags.limit : '20';
  const offset = typeof flags.offset === 'string' ? flags.offset : '0';
  const params = new URLSearchParams({ limit, offset });
  if (term) params.set('q', term);
  if (user) params.set('user', user);
  const cfg = loadBusConfig();
  print(await busRequest(cfg, 'GET', `/api/agents/search?${params.toString()}`));
}

async function cmdShow(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const ref = positional[0];
  if (!ref) throw new Error('metabot agents show: <agentId> required');
  if (flags.sessions === true || flags.sessions === 'true') {
    const cfg = loadBusConfig();
    const limit = typeof flags.limit === 'string' ? flags.limit : '20';
    const offset = typeof flags.offset === 'string' ? flags.offset : '0';
    print(
      await busRequest(
        cfg,
        'GET',
        `/api/agents/${encodeURIComponent(ref)}/sessions?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
      ),
    );
    return;
  }
  return cmdSetVisibility(args, true);
}

async function cmdRegister(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const url = typeof flags.url === 'string' ? flags.url : '';
  if (!url) throw new Error('metabot agents register: --url <url> required');
  const body: Record<string, unknown> = { url };
  const botName = typeof flags['bot-name'] === 'string' ? flags['bot-name'].trim() : '';
  if (botName) body.botName = botName;
  const description = typeof flags.description === 'string' ? flags.description.trim() : '';
  if (description) body.description = description;
  body.visible = flags.hidden === true ? false : true;
  const cfg = loadBusConfig();
  const resp = await busRequest(cfg, 'POST', '/api/agents', body);
  print(resp);
}

async function cmdHeartbeat(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const botName = typeof flags['bot-name'] === 'string' ? flags['bot-name'].trim() : '';
  const cfg = loadBusConfig();
  const body = botName ? { botNames: [botName] } : {};
  const resp = await busRequest(cfg, 'POST', '/api/agents/heartbeat', body);
  print(resp);
}

async function cmdWhoami(): Promise<void> {
  const cfg = loadBusConfig();
  const resp = await busRequest(cfg, 'GET', '/api/whoami');
  print(resp);
}

async function cmdSetVisibility(args: string[], visible: boolean): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  if (!botName) {
    throw new Error(`metabot agents ${visible ? 'visible' : 'hide'}: <botName> required`);
  }
  const cfg = loadBusConfig();
  const resp = await busRequest(cfg, 'PATCH', `/api/agents/${encodeURIComponent(botName)}/visibility`, { visible });
  print(resp);
}

async function cmdRemove(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  if (!botName) throw new Error('metabot agents remove: <botName> required');
  const cfg = loadBusConfig();
  const resp = await busRequest(cfg, 'DELETE', `/api/agents/${encodeURIComponent(botName)}`);
  print(resp);
}

async function readAllowlist(cfg: BusConfig, botName: string): Promise<string[]> {
  // No dedicated GET endpoint — pull /api/agents and find the row. The list
  // route already includes `visibleToOwners` for rows visible to the caller.
  const list = await busRequest<ListResponse>(cfg, 'GET', '/api/agents');
  const row = (list.agents || []).find((a) => a.botName === botName);
  if (!row) throw new Error(`metabot agents: '${botName}' not found in registry (or not visible to you)`);
  return row.visibleToOwners || [];
}

async function cmdShare(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  const ownerName = positional[1];
  if (!botName || !ownerName) {
    throw new Error('metabot agents share: <botName> <ownerName> required');
  }
  const cfg = loadBusConfig();
  const current = await readAllowlist(cfg, botName);
  if (current.includes(ownerName)) {
    print({ botName, visibleToOwners: current, unchanged: true });
    return;
  }
  const next = [...current, ownerName];
  const resp = await busRequest(cfg, 'PATCH', `/api/agents/${encodeURIComponent(botName)}/visible-to-owners`, {
    owners: next,
  });
  print(resp);
}

async function cmdUnshare(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  const ownerName = positional[1];
  if (!botName || !ownerName) {
    throw new Error('metabot agents unshare: <botName> <ownerName> required');
  }
  const cfg = loadBusConfig();
  const current = await readAllowlist(cfg, botName);
  if (!current.includes(ownerName)) {
    print({ botName, visibleToOwners: current, unchanged: true });
    return;
  }
  const next = current.filter((o) => o !== ownerName);
  const resp = await busRequest(cfg, 'PATCH', `/api/agents/${encodeURIComponent(botName)}/visible-to-owners`, {
    owners: next,
  });
  print(resp);
}

async function cmdShared(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const botName = positional[0];
  if (!botName) throw new Error('metabot agents shared: <botName> required');
  const cfg = loadBusConfig();
  const current = await readAllowlist(cfg, botName);
  print({ botName, visibleToOwners: current });
}

export async function run(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (
    (rest.includes('--help') || rest.includes('-h')) &&
    [
      'list',
      'register',
      'heartbeat',
      'whoami',
      'visible',
      'show',
      'hide',
      'remove',
      'delete',
      'share',
      'unshare',
      'shared',
    ].includes(sub)
  ) {
    process.stdout.write(usage());
    return;
  }
  switch (sub) {
    case 'list':
      return cmdList(rest);
    case 'search':
      return cmdSearch(rest);
    case 'register':
      return cmdRegister(rest);
    case 'heartbeat':
      return cmdHeartbeat(rest);
    case 'whoami':
      return cmdWhoami();
    case 'visible':
    case 'show':
      return cmdShow(rest);
    case 'hide':
      return cmdSetVisibility(rest, false);
    case 'remove':
    case 'delete':
      return cmdRemove(rest);
    case 'share':
      return cmdShare(rest);
    case 'unshare':
      return cmdUnshare(rest);
    case 'shared':
      return cmdShared(rest);
    default:
      process.stderr.write(`metabot agents: unknown subcommand '${sub}'\n\n`);
      process.stdout.write(usage());
      process.exit(2);
  }
}
