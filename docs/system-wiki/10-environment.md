---
title: Environment & dependencies
slug: environment
group: Operations
order: 1
---

# Environment & dependencies

## Required env vars

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | The agent SDK uses this to call Claude. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_KEY` | Service-role key for `pipelines` + `pipeline_events` writes. |
| `KRAHNBORN_API_TOKEN` | Shared bearer token for `/requests` and `/respond`. |
| `SLACK_BOT_TOKEN` | `xoxb-…`; for outbound DMs. |
| `SLACK_SIGNING_SECRET` | HMAC secret for verifying `/slack/events`. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for verifying `/github/webhook`. |

Optional:

| Var | Default |
|---|---|
| `SLACK_USER_EMAIL` | `thomas@krahnborn.com` |
| `SLACK_USER_NAME_FALLBACK` | `Thomas Jones` |
| `PORT` | `3000` |
| `KRAHNBORN_VAULT_PATH` | `${HOME}/vault` |
| `LOG_LEVEL` | `info` |

`.env.example` in the repo root is the canonical list. `dotenv` loads it on boot.

## External binaries

The orchestrator and agents shell out to:

- `sf` — Salesforce CLI. Used for `org list`, `project deploy start`, `apex run test`, scratch creation, `org open`.
- `gh` — GitHub CLI. Used for `pr create`, `pr view`, `pr diff`, `pr close`, `pr comment`.
- `git` — branch creation, push, pull, reset, force-with-lease.

All three must be on `PATH` and authenticated for the user the server runs as.

## Bin scripts

Live in `bin/`:

- `sf-orgs-summary.sh` — slim, token-stripped org list. Used by Router context-gathering.
- `spin-scratch.sh <devhub> <alias> [days]` — orchestrator-side scratch org creation. Returns slim JSON (`alias`, `orgId`, `username`, `expirationDate`, `loginUrl`).
- `scratch-query.sh "<soql>"` — agent-facing SOQL wrapper that strips Salesforce's `attributes` blocks.
- `scratch-describe.sh <SObject>` — agent-facing describe wrapper that returns only the fields the agent actually needs.

These exist so the *output* the agent ingests is small and safe. Use them instead of raw `sf` commands when the result will end up in an LLM transcript.

## NPM dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | The agent runtime. |
| `@modelcontextprotocol/sdk` | Hosts the in-repo `sf-read` MCP server (`src/mcp/sf-read-mcp.ts`). |
| `@slack/web-api` | Outbound DMs. |
| `@supabase/supabase-js` | DB client. |
| `dotenv` | env loading. |
| `fastify` | HTTP server. |
| `zod` | Tool input schemas for the MCP server. |

Dev:

| Package | Purpose |
|---|---|
| `tsx` | Run TS directly in dev. |
| `typescript` | Compile. |
| `@types/node` | Types. |

No frontend deps. The wikis are built by tsx scripts and emit self-contained HTML.

## Vault layout

```
~/vault/
  clients/
    krahnborn/
      _index.md          ← repo, sf alias, role permset registry
      changes/           ← Documentation agent writes build records here
        2026-05-04-add-account-tier.md
      decisions/         ← per-client ADRs (manual)
    leadventure/
      _index.md
      ...
```

The `_index.md` shape is parsed by `src/config/clients.ts:loadClientConfig`. Required sections:

```markdown
## Org
- `sf` alias: `krahn`

## Repo
- Remote: git@github.com:org/repo.git
- Local: ~/Salesforce/KRAHN/Krahn-Agent-Project

## Permission sets
- `Sales_User_Account_Fields` — Sales reps. ...
- `Field_Tech_Operations` — Field technicians. ...

## MCP servers
- `sf-read` — read-only Salesforce. Scout uses this for prod/scratch reads.
```

Add a bullet to **Permission sets** every time a new role permset gets created and merged so subsequent pipeline runs can extend it.

The **MCP servers** section is the per-client allowlist. Each name must match an entry in `src/mcp/registry.ts`; an unknown name is logged and skipped. A client without this section gets no MCP access, regardless of which agents declare `mcpServers` in code — both have to agree.

## In-repo MCP servers

The `src/mcp/` directory hosts MCP servers that ship with krahnborn-os. They're spawned as stdio subprocesses by the agent SDK during a pipeline run and torn down at the end.

| Server | File | Tools | Used by |
|---|---|---|---|
| `sf-read` | `src/mcp/sf-read-mcp.ts` | `soqlQuery`, `describeSObject` | Scout subagent |

The `sf-read` server wraps `bin/{prod,scratch}-{query,describe}.sh` — same `sf` CLI auth, same slim output shape, same read-only guarantees. The bash wrappers are still used by the parent Execution agent for scratch-org reads; the MCP path is specifically for Scout's mixed prod-and-scratch investigations.
