# MetaMemory

MetaMemory is the persistent knowledge layer built into Core Console. It stores
Markdown or HTML documents in a searchable folder tree and makes sharing an
explicit per-document choice.

## Where to use it

- **Web:** open `http://localhost:9200/memory` and enter the local Core token.
- **CLI:** use `metabot memory ...`; the retired `mm` binary is not supported.
- **Agents:** install or enable the MetaMemory Skill so agents can search and
  update knowledge during a run.

## Essential commands

```bash
metabot memory search "deployment guide"
metabot memory search "deployment guide" --limit 20 --offset 20
metabot memory list
metabot memory get <document-id>
metabot memory path /users/me/project/guide

metabot memory create "Guide" "# Deployment" --share --tags docs,release
echo '# Updated guide' | metabot memory update <document-id>
metabot memory share <document-id> on
metabot memory mkdir project-notes --path /users/me/project-notes
metabot memory delete <document-id>
metabot memory health
```

`create` and `update` read content from standard input when the content argument
is omitted. Use `--html` only for a complete HTML document; Markdown is the
default.

Search results are ranked and capped at 100 per request. Use `--offset` with
`--limit` to retrieve later pages. The Core Console search page exposes the
same paging through its **load more** control.

## Paths and sharing

Paths organize documents but do not grant access. New writes default to your
own `/users/<owner>/...` namespace. A document is cross-agent readable only
when `shared=true`:

```bash
metabot memory visibility private   # default new documents to private
metabot memory create "Private note" "..." --no-share
metabot memory share <document-id> on
```

Keep credentials, device codes, and authorization URLs out of shared memory.

## Connection

The Personal Edition CLI defaults to the local Core:

```bash
export METABOT_CORE_URL=http://localhost:9200
export METABOT_CORE_TOKEN="$(head -n 1 ~/.metabot-core/token)"
```

The token file is created with mode `0600`. Do not paste it into logs or docs.

## Optional Wiki sync

User-configured Feishu/Lark deployments can synchronize selected memory content
to a Wiki space. This is optional and is not required by Personal Edition. See
[Wiki Sync](wiki-sync.md).
