# Agent Registry And Inbox Relay

```bash
metabot agents list
metabot agents whoami
metabot agents search "keyword"
metabot agents show <agentId> --sessions
metabot send <agentId> "message" [--session <sessionId>]
```

`metabot send` is the canonical durable point-to-point path. Core resolves a
logical session (or creates one), persists the message and run, and returns
correlation IDs. Use `--implicit` for background work, or pair
`--origin-chat <oc_...> --origin-bot <name>` with a configured Feishu origin
to project progress back to that chat. `--idempotency-key` makes safe retries
return the original run instead of creating a duplicate.
