# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.3.2] - 2026-09-15

### Added

- Added isolated Feishu topic conversations for group chats and bot direct messages, including topic-scoped sessions, queues, media, replies, and reset/stop commands.
- Added optional `larkDomain` configuration for Lark international applications and exposed GPT-6 Astra models in the Codex model picker.

### Fixed

- Fixed long one-time scheduler delays firing early, AskUserQuestion fallback after resumed sessions, Windows Claude executable selection, and Kimi Code 0.28+ daemon startup via `web`.
- Fixed MetaMemory CLI bootstrap-token discovery, doc-sync cleanup on transient fetch failures, atomic memory writes, and Windows test home isolation.
- Added a clone-friendly PM2 `BOTS_CONFIG` default.

## [1.3.1] - 2026-09-11

### Fixed

- Fixed the T5T `no_evaluator` anomaly handling with a 24-hour initialization grace period and no persisted metadata.
- Hardened Agent Bus session safety by validating session status, rejecting sends to offline sessions, and filtering SQL status before pagination and caps.
- Locked the transitive `fast-uri` dependency to `3.1.7`.

## [1.3.0] - 2026-07-24

### Added

- The repository now ships a concise root `AGENTS.md` baseline for public contributors while preserving user-owned workspace `AGENTS.md` and `CLAUDE.md` files during install and package updates.
- Agent prompts now include dynamic Current MetaBot Context and compact Team Context sections consistently across Codex, Kimi Code, and Claude compatibility paths.

### Changed

- The packaged `metabot` and `metabot-team` Skills are now the canonical CLI and durable-state references, without duplicate source mirrors or workspace policy.
- The documentation site has a redesigned landing page and a unified theme across inner pages, with outdated Personal Edition pages removed from navigation.
- GitHub Actions now test supported Node.js 22 and use Node.js 24-compatible action runtimes.

## [1.2.0] - 2026-07-19

### Added

- Core Console Chat now renders safe Markdown, near-live Agent output, tool activity, output-file cards, interactive questions with option or free-text answers, run cancellation, voice input, durable conversations, and multi-Agent routing from one token-authenticated page.
- `metabot update --package --version <x.y.z>` installs an immutable GitHub Release and verifies the extracted Personal Edition manifest matches the requested version.
- Release bootstrap upgrade tests prove that `.env`, `bots.json`, Bridge data/logs, `~/.metabot`, and `~/.metabot-core` tokens/data survive package updates.

### Changed

- MetaBot Personal Edition now ships one browser frontend at `http://localhost:9200`. The historical Bridge Live UI has been consolidated into `packages/web-ui`; `http://localhost:9100/web/` redirects to Core Console Chat.
- `metabot update` resolves the latest GitHub Release installer, runtime tarball, and `SHA256SUMS` directly. Package updates report the old and new versions, rebuild Bridge/Core/UI, restart owned PM2 processes, and fail closed on checksum or pinned-version mismatch.
- The updater removes only the recognized legacy `metabot-web` source/build tree after upgrading, while preserving all user-owned configuration, credentials, logs, workspaces, and databases.

### Removed

- The second `web/` React/Vite application and its `build:web` pipeline.

## Pre-1.0 development history

### Changed

- **Memory sharing is now a per-doc flag, not a path** — writes are always confined to the caller's own namespace (`/users/<owner>/...` or `/users/<owner>/agents/<bot>/`), and cross-bot read access is governed by a new document-level `shared` flag instead of the `/shared/` path. This fixes the bug where a public bot's _default_ write target was `/shared/<bot>` but the server ACL never granted members write access there, so every default `metabot memory create` 403'd. A new doc's `shared` defaults from the authoring agent's `memoryPublic` config (public → shared, private → not) and is overridable per document via `--share` / `--no-share` on `create`/`update`, or flipped later with `metabot memory share <doc> on|off`. `metabot memory visibility public|private` now sets that _default share_ rather than a write path. Reads: a `shared` doc is readable by any authenticated bot regardless of where it lives; legacy `/shared/*` docs are backfilled to `shared=1` for read-compatibility. Schema adds an idempotent `documents.shared` column.
- **CLI merge — `mb` folded into `metabot`** — `metabot` is now the single CLI binary. It absorbed the bridge daemon API commands formerly under `mb` (`bots`, `bot`, `talk`, `schedule`, `peers`, `stats`, `metrics`, `voice`, `health`), which curl the local bridge at `localhost:9100`. The per-bot Skill Hub moved to a new distinct command word — `metabot bot-skills` (was `mb skills`) — to avoid colliding with the central `metabot skills` delegation. `bin/mb` is now a thin deprecation wrapper that forwards to `metabot` (`mb skills` → `metabot bot-skills`); existing `mb` scripts keep working with a stderr notice. The stale `mb()` bash-alias function is no longer written to `~/.bash_aliases` by `install.sh`.
- **Monorepo merge** — absorbed `xvirobotics/metabot-core` into this repo as an npm-workspaces monorepo under `packages/`. The central HTTP server, feature CLI, central SPA, and shared clients now live alongside the bridge runtime. Bot-host installs no longer clone a sibling repo; `metabot update` does a single pull + build. HTTP `/api/*` remains the only boundary between bridge and server halves, enforced by `package.json` exports, ESLint `no-restricted-imports`, and start-script contracts. ECS server source path moves from `~/metabot-workspace/metabot-core` to `~/metabot/packages/server`. Per-file history preserved via subtree-merge (MR !8, squash `3766982f`).

### Added

- `install.sh`: `--dir <path>` / `-d <path>` flag to customize the install directory (priority: `--dir` > `METABOT_HOME` env > interactive prompt > `~/metabot`). Non-default paths are persisted to `~/.bashrc` / `~/.zshrc` so the `mb`/`mm`/`metabot` CLIs find the install in new shells.
- `install.ps1`: matching `-Dir <path>` parameter on Windows; non-default paths persisted via user-level `METABOT_HOME` environment variable.
- CONTRIBUTING.md with development setup guide
- GitHub Actions CI workflow (Node.js 20/22 build + type check)
- Issue templates for bug reports and feature requests
- README badges (CI, license, stars)

### Fixed

- Timeout error message now correctly shows "1 hour limit" instead of "10 min limit"
- Memory client API response format handling (unwrapArray/unwrapSingle)

## [1.0.0] - 2025-02-20

### Added

- Feishu/Lark to Claude Code bridge via Agent SDK
- Real-time streaming card updates
- Multi-bot support (multiple Feishu apps in one process)
- Multi-user parallel sessions (per-chat isolation)
- Multi-turn conversations with session persistence
- Image support (send to Claude, receive generated images)
- File upload/download support
- MCP server integration (loads from Claude Code settings)
- Interactive Q&A (Claude can ask questions, user answers in chat)
- Status cards with color-coded states, tool call tracking, cost/duration
- Memory server integration (MetaMemory)
- Bot commands: `/help`, `/reset`, `/stop`, `/status`, `/memory`
- Authorization via user IDs and chat IDs
- PM2 deployment with auto-restart
