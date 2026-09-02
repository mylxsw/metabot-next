# Unified Core Console

MetaBot Personal Edition ships one browser frontend: Core Console.

**URL**: `http://localhost:9200`

The installer stores the generated Bearer token in `~/.metabot-core/token`. Paste it on first open to use Chat, Agents, Memory, Skills, T5T, Teams, and CLI Access from one navigation shell.

## Chat

Core Console Chat combines live execution with Core's durable Conversation,
Run, and multi-Agent model:

- streamed Agent responses and live run state
- tool activity from Codex, Kimi Code, and the Claude compatibility engine
- Markdown, code block, table, and link rendering
- interactive Agent questions answered in the page
- cancellation of active runs
- output-file metadata cards
- browser Speech Recognition with Bridge STT fallback
- Agent DMs and groups routed with `@Agent`
- per-conversation engine and model selection

The console can subscribe to `GET /api/chat/conversations/<id>/stream` with the
same Bearer token. The stream sends an initial `snapshot` event, then
`message.created`, `run.updated`, `run.event`, and `file.created` events as the
conversation changes. It is participant-scoped; non-participants receive
`403`, and the server emits periodic comment heartbeats to keep proxies from
closing idle connections.

## Architecture

```text
browser :9200
  └─ packages/web-ui/ (the only React SPA)
       └─ packages/server/ (token auth, conversations, runs, Memory, Skills, T5T)
            └─ Agent Bus inbox
                 └─ Bridge :9100 (Codex / Kimi Code / Claude execution)
                      └─ run state, tools, questions, and file events back to Core
```

The source lives in `packages/web-ui/`; Vite writes the build to
`packages/server/static/`. The Bridge executes agents and relays live state; it
does not ship another browser frontend.

## Development

```bash
npm run dev -w @xvirobotics/metabot-core-web-ui
npm run build -w @xvirobotics/metabot-core-web-ui
npm run build:bridge
```

The Vite development server uses port `5173` and proxies `/api`, `/admin`, and `/health` to local Core on `9200`.
