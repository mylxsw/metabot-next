# @xvirobotics/cli

`metabot` — unified CLI for Personal Core, including the durable Agent Bus
send path. The binary keeps user-selected Core URLs and tokens configurable;
no hosted or private service is required.

## Subcommands

| Subcommand           | Backed by                  | Notes                          |
|----------------------|----------------------------|--------------------------------|
| `metabot memory`     | `@xvirobotics/metamemory`  | alias of `mm`                  |
| `metabot skills`     | `@xvirobotics/skill-hub`   | alias of `mh`                  |
| `metabot agents`     | Personal Core agent registry | list, search, register, visibility, sessions |
| `metabot send`       | Personal Core Agent Bus      | durable point-to-point message with optional session/idempotency |
| `metabot t5t`        | (pending Phase 3 — trunks) | prints placeholder string      |
| `metabot help`       |                            | also `--help`, `-h`, no args   |

The existing `mm` and `mh` binaries keep working unchanged. Use
`metabot send <agentId> "message"` for Agent Bus communication; Core resolves
the target session and returns message, session, and run IDs.

## Install

```
npm install -g @xvirobotics/cli
metabot help
```

## Env

- `METABOT_CORE_URL` — default `http://localhost:9200` (locally self-hosted metabot-core); set your own remote host if you run it elsewhere
- `METABOT_CORE_TOKEN` — bearer token (falls back to first line of `~/.metabot-core/token`)
