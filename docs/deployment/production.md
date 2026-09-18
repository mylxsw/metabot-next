# Production Deployment

The signed GitHub Release installer is the supported Personal Edition
deployment path. It installs two local services:

| Service | Default port | Purpose |
|---|---:|---|
| Core Console | `9200` | Web UI, Chat, Agents, Memory, Skills, T5T, Teams, CLI APIs |
| Bridge | `9100` | IM channels, engine execution, scheduling, voice, peer routing |

MetaMemory is part of Core. There is no standalone service on port `8100`.

## Install and verify

```bash
curl -fsSL https://github.com/xvirobotics/metabot/releases/latest/download/install.sh | bash

metabot status
metabot doctor
curl -fsS http://localhost:9200/health
```

The installer verifies `SHA256SUMS`, validates the Personal Edition manifest,
and starts the owned PM2 applications. Enable boot persistence after both
services are healthy:

```bash
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`, then run `pm2 save` again.

## No inbound port is required for chat channels

- Feishu/Lark uses a persistent outbound WebSocket.
- Telegram uses outbound long polling.
- Local Web access works on loopback.

Only publish Core when remote browser access is intentional. Keep Bridge on
loopback or a private network unless a separate authenticated API endpoint is
required.

## HTTPS reverse proxy

Mobile microphone access and remote browser use require a secure context. A
minimal Caddy configuration proxies the single Core Console:

```caddy
metabot.example.com {
    reverse_proxy 127.0.0.1:9200
}
```

Then configure remote CLI clients:

```bash
export METABOT_CORE_URL=https://metabot.example.com
export METABOT_CORE_TOKEN="<personal-token>"
metabot memory health
```

Use a private network such as Tailscale or WireGuard when public access is not
needed. Never publish the raw token in a URL, shell history, or shared config.

## Bridge remote access

Most users do not need this. Commands such as `metabot bots`, `schedule`,
`teams`, `peers`, and `voice` use the Bridge API. If remote Bridge access is
required:

1. set a strong `API_SECRET`;
2. proxy `127.0.0.1:9100` through a separate authenticated HTTPS hostname or a
   private network;
3. set `METABOT_URL` on the client.

Do not reuse the Core token as the Bridge secret.

## Restart safety

Use `metabot restart` instead of calling `pm2 restart metabot` directly. The
CLI coordinates the process-wide restart with every active bot chat, persists
the handoff, and resumes interrupted user-facing turns after the new Bridge is
listening. Direct PM2 commands bypass that contract and can interrupt all bots
without preparation or completion cards.

The first update that introduces this protocol may see a 404 from the still-old
Bridge. `metabot update` permits that one compatibility handoff; subsequent
updates require coordinated preparation. No database migration is involved.

## Update and rollback

```bash
metabot update                                  # latest verified release
metabot update --package --version 1.3.2        # known immutable release
metabot doctor
```

Package overlays preserve `.env`, `bots.json`, `data/`, `logs/`, and user/Core
state under `~/.metabot/` and `~/.metabot-core/`. If a new release fails your
smoke checks, reinstall the previously known version explicitly instead of
editing installed package files.

Rollback does not require changing `sessions.db`. Reinstall the previous
release and remove a stale `~/.metabot/controlled-restart.json` only after
confirming no restart is in progress; older releases ignore that file.

## Source deployments

Source checkouts use an explicit path:

```bash
git pull --ff-only
npm ci --include=dev
npm test
npm run build
metabot update --git
```

Keep package-managed and source-managed installations separate. For the Web
request path, see [Core Console architecture](../features/web-ui.md#architecture).
