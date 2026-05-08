---
title: Notes & decisions
slug: notes
group: Reference
order: 1
---

# Notes & decisions

The non-obvious choices made along the way, plus things deferred to a later phase.

## Decisions made

### Self-hosted, scope-limited Salesforce MCP

Originally Phase 0+ used `sf` CLI for everything. As of the Scout/MCP integration, there's a single self-hosted MCP server (`src/mcp/sf-read-mcp.ts`) that wraps the existing `bin/{prod,scratch}-{query,describe}.sh` shell scripts as `soqlQuery` / `describeSObject` tools. **Only the Scout subagent uses it.** The orchestrator, Triage, Router, Work Identifier, Execution (parent), and Documentation agents all still use the `sf` CLI directly.

Why self-hosted instead of pulling an off-the-shelf Salesforce MCP: the bin wrappers already strip Salesforce's `attributes` blocks and slim the describe output for LLM context. Off-the-shelf MCPs return raw payloads, blowing up Scout's context. Wrapping our own scripts is ~90 lines and keeps the existing token-stripping discipline.

Why scope-limited to Scout: MCP tool schemas cost context tokens for every agent that has them attached. Scout is the *exploratory* read-side agent — the only one whose job is "find out what's already in Salesforce." Other agents either don't read orgs (Triage, Router on local-only data, Documentation) or already know what they need (Execution, Work Identifier).

Why per-client allowlist via vault: per-client `_index.md` declares which named MCP servers a pipeline for that client may spawn. The code registry decides how to spawn them; the vault decides whether they're allowed. Both have to agree, so there's no path where adding a new client accidentally exposes an MCP server.

### Dev-Hub-only Router

Per direction (2026-04-30): the Router only ever recommends orgs with `isDevHub: true`. Real work always runs in a scratch org spun from that Dev Hub.

### Client list = vault folders

No hardcoded client array, no `clients` table. `~/vault/clients/<name>/_index.md` is the source of truth. Adding a client means adding a folder; removing one means removing a folder. The DB doesn't care.

### Per-client role permset registry, not feature permsets

The pipeline's WI agent is required to extend an existing role permset before proposing a new one, and any `create_new` proposal pauses for human confirmation. The permset registry lives in `vault/clients/<name>/_index.md` under a `## Permission sets` section.

This is the single most important guardrail against the system devolving into a junk drawer of one-off permsets.

### Hosting = local

No VPS, no Railway, no Fly. Single Fastify process on a personal machine. The Slack/GitHub webhooks need a public URL but that's solved by `cloudflared tunnel` for now. Move to a managed host once the system has consistent uptime requirements.

The same tunnel hostname (`agents.krahnagents.com`) routes a second path (`/console/*`) to the Krahn Console process on `:3001`. The Console can read `~/vault/clients/` directly precisely *because* it runs locally — its modal dropdown is a filesystem read, not an API call. Moving either process off the laptop forces a vault-access redesign.

### No SDK subagent wrapper

The Anthropic SDK supports defining each agent as an `AgentDefinition` and orchestrating via a parent agent that uses `Task`. We don't do that. For deterministic sequencing (Triage → Router → ...) the Fastify orchestrator is the conductor and calls `query()` directly per stage. Revisit when an agent's order-of-operations actually depends on prior agents' output in non-trivial ways.

### `permissionMode: 'bypassPermissions'`

Combined with `allowDangerouslySkipPermissions: true`. Acceptable for local + single-tenant use. The hard rules (profile lockdown, scratch-target only, etc) are enforced at the prompt + orchestrator layer rather than via per-tool permission prompts. Revisit before any networked or multi-tenant deployment.

### One process

Single-process Fastify is the orchestrator. The per-client repo lock is in-memory. A server restart loses the lock state — but persisted pipeline state in Supabase is fine to retry. The day this becomes a Postgres advisory lock is the day we leave one process.

### Two Slack apps, not one

The workspace has a **Notifier** (this repo) and a **Krahn Console** (`slack-agents/krahn-console`) as separate api.slack.com apps with separate bot identities. Slack routes button clicks to whichever app posted the message, so co-locating "I post the DM with the Cancel button" and "I host the slash command + Home tab" in one app would force one of the surfaces to delegate via webhook anyway. Splitting them keeps each app's manifest, scopes, and request URL focused. Costs paid: two `.env` files, two processes to run, two manifest URLs to maintain. See [Architecture → Slack surface](#architecture).

### Slack-agents and krahnborn-os are deployment peers

The Krahn Console lives in a sibling repo (`~/Salesforce/AGENTS/slack-agents/`), not under this one. They communicate over HTTP (`POST /requests`) and shared Supabase state — no imported code, no symlink, no monorepo. When working in Claude Code, opening a session in `slack-agents/` does not auto-load this wiki and vice versa; cross-repo changes require either telling Claude to read both, or opening at `~/Salesforce/AGENTS/` so the working directory spans both subtrees.

## Known issues

### `npm audit`: 2 moderate vulns in the SDK

`@anthropic-ai/sdk` 0.79.0–0.91.0 has insecure default file permissions in the memory tool (GHSA-p7fg-763f-g4gf). The pipeline does not use the memory tool, so it's not blocking. The npm-suggested "fix" is a downgrade to `claude-agent-sdk@0.2.90`, which is backward — wait for a forward fix in a future SDK release before shipping anything that uses memory.

### No automatic scratch teardown

Scratch orgs spun by the pipeline live for 7 days (the default) and then auto-expire on the Dev Hub. If you need a Dev Hub slot back earlier: `sf org delete --target-org <alias>` manually. The Execution agent is forbidden from deleting orgs on its own.

### Concurrency is a single-process mutex

Two pipelines for the same client can both reach `awaiting_input`, but their *active* phases are serialized. Across-process concurrency would need a Postgres advisory lock or external coordination. Not needed yet.

### No replay tooling for webhooks

If a Slack signature times out (5-min window) or the GitHub delivery is lost, there's no "click to retry" workflow. Manual fix: re-trigger via `npm run respond` or by re-firing the GitHub delivery from the repo's webhook settings.

### Top-level Slack DMs are not requests

The bot replies "thread reply only" to top-level DMs. Submitting a new request from Slack would require reasoning about authorization and rate-limiting; punted to a later phase.

### Profile lockdown post-PR, not pre-PR

The diff guard runs *after* the agent opens a PR. A more robust pre-PR guard would intercept the Bash tool to refuse `sf project deploy start` calls touching profile paths. The post-PR guard is fine for now (the PR gets closed, the branch reset, the pipeline pauses) but it spends more compute than necessary.

### The diff guard force-resets the agent's branch

`resetFeatureBranch` runs `git reset --hard origin/main` + `git push --force-with-lease`. It's acceptable because the branch is always orchestrator-owned (`krahnborn-os/<id>-<slug>`), but if a human ever manually pushed to such a branch their work would be wiped. Don't push manually to those branches.

### `setupExecutionEnvironment` requires a clean tree

If you have uncommitted local changes in the client metadata repo, the pipeline refuses to start. This is the right behavior, but the failure DM could be friendlier — currently it just surfaces `git status --porcelain` output.
