# metabot CLI

`metabot` is the single MetaBot CLI binary. It has three command categories:

1. **Bridge process control** — manage the local MetaBot service lifecycle.
2. **Bridge daemon API** — curl the local bridge daemon at `localhost:9100`.
3. **metabot-core delegation** — forward to the central feature CLI.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/metabot`.

> The legacy `mb` / `mm` / `mh` CLIs have been removed. Install and update
> actively delete any leftover binaries from `~/.local/bin/`; if a script
> still calls them you'll see `command not found` — switch the call to
> `metabot <subcommand>`.

## 1. Bridge process control

```bash
metabot update                                  # package install: latest GitHub Release
metabot update --package                        # force latest GitHub Release package
metabot update --package --version 1.3.0        # pin immutable Release v1.3.0
metabot update --git                            # force git pull + rebuild + restart
metabot start                       # start with PM2
metabot stop                        # stop
metabot restart                     # coordinated Bridge restart
metabot restart --bot admin --chat oc_x --reason "upgrade"  # report back to a chat
metabot restart --no-resume         # notify, but do not queue interrupted turns
metabot restart --force             # emergency override if prepare cannot complete
metabot logs                        # view live logs (pass -n 100 etc.)
metabot status                      # PM2 process status
```

For a normal package-managed personal edition, `metabot update` defaults to the
latest GitHub Release. A source checkout is auto-detected and keeps its Git
update path; use `--package` to force a Release overlay.

`metabot update --package --version 1.3.0` selects the immutable v1.3.0 assets
instead of `latest`. Package updating performs:

1. Download `install.sh`, `metabot-runtime.tgz`, and `SHA256SUMS` from the latest or pinned GitHub Release.
2. Verify the runtime SHA256 before extraction.
3. Validate the complete personal-edition manifest and its semantic version; a pinned version must match exactly.
4. Overlay code into `METABOT_HOME`, preserving `.env`, `bots.json`, `logs/`, `data/`, and `.git/`.
5. Preserve user/Core state under `~/.metabot/` and `~/.metabot-core/`; only package-owned `~/.metabot/default.env` may be refreshed.
6. Install dependencies and build the Bridge, Core, Web UI, and delegated CLI.
7. Refresh bundled/workspace Skills and existing Lark CLI Skills when present.
8. Restart the managed PM2 services.

Override the package installer mirror with `METABOT_UPDATE_INSTALLER_URL`.
`--version` accepts only `x.y.z` (an optional leading `v` is normalized) and
cannot be combined with `--git`.

### Coordinated restart

`metabot restart` first asks the authenticated local Bridge to prepare. The
Bridge briefly stops accepting new work, snapshots every active task across
all registered bots, and sends a **Restart Preparing** notice to each affected
chat using that bot's own channel identity. If any affected chat cannot be
notified, the restart is cancelled and normal work is unfrozen. `--force` is
the explicit emergency override.

After PM2 starts the new Bridge, each affected bot updates its interrupted
card, sends a **Restart Complete** notice, and queues exactly one continuation
turn. A stable `--request-id` deduplicates retries. `--bot` plus `--chat` also
reports the result to an idle requester chat; idle bots without a destination
chat are not sent unsolicited messages.

The handoff is stored atomically under `SESSION_STORE_DIR` (normally
`~/.metabot/`) in `controlled-restart.json` and `last-restart.json`. It does not
modify the session database. If PM2 rejects the restart, the CLI cancels the
Bridge's prepare state and removes the breadcrumb before returning an error.

## 2. Bridge daemon API

These commands curl the local bridge daemon at `localhost:9100`, reading
`API_PORT` / `API_SECRET` (and optional `METABOT_URL`) from the bridge `.env`.

### Bot management

```bash
metabot bots                        # list all bots (local + peer)
metabot bot <name>                  # get bot details
```

### Agent talk

For durable point-to-point delivery through Personal Core, prefer the minimal
Agent Bus command:

```bash
metabot send <agentId> "prompt"
metabot send <agentId> "prompt" --session <sessionId> --idempotency-key <key>
metabot send <agentId> "background task" --implicit
```

Core persists the message and logical run, resolves a usable target session,
and returns `messageId`, `sessionId`, and `runId`. Set
`--origin-chat <oc_...> --origin-bot <name>` when a Feishu-origin bridge should
receive progress; use `--child-direct` to keep presentation in the target chat.

```bash
metabot talk <bot> <chatId> <prompt>      # talk to a bot (bridge /api/talk)
metabot talk alice/bot <chatId> <prompt>  # talk to a specific peer's bot
```

The bot name supports [qualified names](../features/peers.md#qualified-names)
(`peerName/botName`) for bridge-local routing. For durable cross-agent
communication through Personal Core, use:

```bash
metabot send <agentId> "prompt"
metabot send <agentId> "prompt" --session <sessionId> --idempotency-key <key>
metabot send <agentId> "background task" --implicit
```

Core persists the message and logical run, resolves a usable target session,
and returns `messageId`, `sessionId`, and `runId`. In a Feishu-origin context,
`--origin-chat <oc_...> --origin-bot <name>` projects run events back to the
origin bot; `--child-direct` keeps presentation in the target agent chat.

### Peers

```bash
metabot peers                       # list peers and status
```

### Agent Teams

`metabot teams` talks to the local bridge `/api/agent-teams/*` API. It is the coordination surface for MetaBot Agent Teams: agents, mailbox messages, shared tasks, and background runs.

```bash
metabot teams list
metabot teams create <team> [--description <text>]
metabot teams status <team>
metabot teams start <team>
metabot teams stop <team>
metabot teams delete <team>

metabot teams agents list <team>
metabot teams agents spawn <team> <name> [--role <role>] [--engine claude|codex|kimi] [--prompt <text>]
metabot teams agents stop <team> <name>
metabot teams agents delete <team> <name>

metabot teams send <team> <to> <message> [--from <name>] [--summary <text>]
metabot teams inbox <team> <name> [--unread] [--read]

metabot teams tasks list <team>
metabot teams tasks create <team> <subject> [--description <text>] [--owner <name>]
metabot teams tasks get <team> <id>
metabot teams tasks update <team> <id> [--status pending|in_progress|completed|deleted] [--owner <name>] [--result <text>]

metabot teams runs list <team>
metabot teams runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
metabot teams runs output <team> <runId>
metabot teams runs stop <team> <runId>
```

`runs stop` marks the run `stopped` and, when the bridge supervisor owns the in-flight run, asks the bridge to stop that teammate chat task, requeues assigned in-progress tasks to `pending`, and suppresses late executor output for that stopped run.

The same command surface is implemented in both `bin/metabot` and the TypeScript feature CLI under `packages/cli`. The bridge reads `API_PORT` / `API_SECRET` and optional `METABOT_URL` from `.env`.

### Scheduling

```bash
metabot schedule list                                          # list all tasks
metabot schedule cron <bot> <chatId> '<cron>' <prompt>         # create recurring task
metabot schedule add <bot> <chatId> <delaySec> <prompt>        # create one-time task
metabot schedule pause <id>                                    # pause a task
metabot schedule resume <id>                                   # resume a task
metabot schedule cancel <id>                                   # cancel a task
```

### Stats, metrics & health

```bash
metabot stats                       # cost & usage statistics
metabot metrics                     # Prometheus metrics
metabot health                      # health check
```

### Voice

```bash
metabot voice call <bot> <chatId> [prompt] [-w opening]  # start an RTC voice call
metabot voice transcript <sessionId>                     # get call transcript
metabot voice list                                       # list active voice sessions
metabot voice config                                     # check RTC configuration
metabot voice tts "Hello world"                          # generate MP3, print file path
metabot voice tts "Hello" --play                         # generate and play audio
metabot voice tts "Hello" -o greeting.mp3                # save to specific file
echo "Long text" | metabot voice tts                     # read from stdin
metabot voice tts "Hello" --provider doubao              # use specific TTS provider
metabot voice tts "Hello" --voice nova                   # use specific voice
```

TTS flags:

| Flag              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `--play`          | Play audio after generating (macOS: afplay, Linux: mpv/ffplay/play)   |
| `-o FILE`         | Save to specific file (default: `/tmp/metabot-voice-<timestamp>.mp3`) |
| `--provider NAME` | TTS provider: `doubao`, `openai`, or `elevenlabs`                     |
| `--voice ID`      | Voice/speaker ID (provider-specific)                                  |

## 3. metabot-core delegation

Any subcommand not listed above is forwarded to the metabot-core feature CLI
(`packages/cli/bin/metabot`):

```bash
metabot t5t board                   # team standup board
metabot agents list                 # peer-bot directory
metabot memory search "<query>"     # shared-memory full-text search
metabot skills list                 # central Skill Hub
```

`METABOT_CORE_URL` / `METABOT_CORE_TOKEN` are fed from the bridge `.env` when
not already exported. Override the CLI path with
`export METABOT_CORE_CLI=/path/to/packages/cli/bin/metabot`.

## Remote Access

By default, the bridge daemon API connects to `http://localhost:9100`. For
internet-reachable deployments, point it at your HTTPS reverse proxy. If you use
a private network such as Tailscale or WireGuard, you can use that private
address instead.

```bash
# Generate a secret once: openssl rand -hex 32
# In ~/.metabot/.env or ~/metabot/.env
METABOT_URL=http://your-server:9100
API_SECRET=your-secret
```
