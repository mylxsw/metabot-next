export function print(): void {
  process.stdout.write(
    `metabot — unified CLI for the metabot-core ecosystem.

Usage: metabot <subcommand> [args]

Primary subcommands:
  memory <cmd> [args]   shared knowledge / notes
                        e.g. metabot memory search "auth" | metabot memory health
  skills <cmd> [args]   skill registry (alias: skill)
                        e.g. metabot skills list | metabot skills install <name>
  send <agentId> "message"  minimal point-to-point Agent Bus send
                             in Feishu context, proxy progress to origin chat
                             optional: --session <sessionId> | --implicit
                                       --origin-chat <oc_...> --origin-bot <name>
                                       --child-direct
  t5t <cmd> [args]      daily team status portal (board / projects / entries)
                        e.g. metabot t5t board | metabot t5t push <slug> <date> "<item>"
  help                  this message (also --help, -h, or bare invocation)

Use metabot send for all point-to-point Agent Bus communication. The old
chat/inbox/agents-talk CLI surfaces are no longer shipped; server fallback
routes remain internal compatibility plumbing only.

Each subcommand has its own help; pass --help through to see it:
  metabot memory --help
  metabot skills --help
  metabot send --help
  metabot t5t --help

Env:
  METABOT_CORE_URL              default http://localhost:9200
  METABOT_CORE_TOKEN            bearer token (or write to ~/.metabot-core/token)
  METABOT_CORE_AGENT_BUS_URL    optional override of the agent-registry base URL (falls back to METABOT_CORE_URL)
`,
  );
}
