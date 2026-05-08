---
title: Architecture
slug: architecture
group: Technical
order: 1
---

# Architecture

## Stack

- **Runtime**: Node 22 + TypeScript, ESM. Run via `tsx` in dev, compiled with `tsc` for prod.
- **HTTP**: Fastify 5. Single process. All routes registered in `src/index.ts`.
- **DB**: Supabase (Postgres + supabase-js client). One table for state (`pipelines`), one for events (`pipeline_events`).
- **Agents**: `@anthropic-ai/claude-agent-sdk`. Each stage calls `query()` directly with a fresh session per run; resume works via the SDK's `resume: <sessionId>` option.
- **Salesforce**: `sf` CLI shelled out from the orchestrator + Execution agent. No Salesforce MCPs.
- **GitHub**: `gh` CLI (Execution + Documentation agents) + a webhook receiver for merge events.
- **Slack**: `@slack/web-api` for outbound DMs; `/slack/events` for inbound thread replies.
- **Vault**: plain markdown files at `~/vault/clients/<name>/_index.md`. The source of truth for client→repo mapping and per-client role permsets.

No frontend. No Redis, no queue. The single Fastify process is the orchestrator.

## Data flow

```
Client request
   │
   ▼
POST /requests ───► Triage agent (Haiku) ───► [maybe pause]
   │                                              │
   │ (resume via /respond or Slack)               │
   ▼                                              ▼
Router agent (Sonnet)
   │
   ▼
Work Identifier agent (Sonnet) ───► [maybe pause]
   │                                  │
   │ (resume via /respond or Slack)   │
   ▼                                  ▼
Orchestrator setup
  • git fetch + checkout main
  • create feature branch
  • spin scratch org
  • source-push main into scratch
  • set project-local target-org
   │
   ▼
Execution agent (Sonnet, 60 turns)
  • read spec
  • edit metadata XML
  • deploy to scratch
  • run tests
  • commit + push + open PR
   │
   ▼
Diff guard ─── violation? ─► close PR, reset branch, pause
   │
   ▼
awaiting_review
   │
   ▼ (PR merged on GitHub)
POST /github/webhook
   │
   ▼
Documentation agent (Sonnet)
  • read PR diff
  • write vault build record
   │
   ▼
completed
```

## Concurrency model

- **One Fastify process.** No clustering.
- **Per-client repo lock** is an in-memory async mutex (`src/execution/repo-lock.ts`). It serializes active execution runs for the same `client_id` so two pipelines never fight over the working tree, the feature branch, or `.sf/config.json`. Two pipelines can both reach `awaiting_input` for the same client; only their *active* phases are serialized.
- The lock is released when the active phase ends — pause, success, or failure. A subsequent resume re-acquires it.
- **Cross-client** pipelines run in parallel. The lock is keyed on `client_id`.

## Idempotency

- `claimForRunning` and `claimForDocumentation` are atomic UPDATE-with-WHERE flips so duplicate webhook deliveries (Slack retry, GitHub retry) lose the race rather than double-process.
- The orchestrator never re-runs a stage that already logged `stage_completed` for the current pipeline.
- The diff guard nulls out `pr_url` when it pauses, so a subsequent execution run starts clean.

## Observability

- `pipeline_events` is the audit log. Every stage logs `stage_started`, `stage_completed`, and `stage_telemetry`. Pauses log `awaiting_input`. The diff guard logs `diff_guard_violation`. Failures log `stage_failed`.
- `npm run pipelines` lists recent rows; `npm run pipelines -- <id>` shows the full event stream and the cost/turn telemetry per stage.

## Slack surface: two apps, two processes

The Slack workspace (`krahnborn`) hosts **two distinct Slack apps**, each owning a different surface. Both run as separate Node processes on the same machine.

| App | Process | Port | Owns |
|---|---|---|---|
| **Notifier** (this repo, krahnborn-os) | Fastify | 3000 | Outbound DMs, thread-reply resume, Cancel buttons |
| **Krahn Console** (`~/Salesforce/AGENTS/slack-agents/krahn-console`) | Bolt-TS | 3001 | `/krahn` slash command + modal, App Home dashboard |

```
Slack → agents.krahnagents.com (cloudflared tunnel)
          │
          ├── /slack/events, /slack/interactions ─► localhost:3000  (krahnborn-os Notifier)
          ├── /github/webhook                    ─► localhost:3000
          └── /console/slack/events              ─► localhost:3001  (Krahn Console)
```

**Why two apps:** Slack delivers button clicks back to whichever app posted the message. The Notifier owns DMs and thread replies (so the Cancel button must live on Notifier messages); the Console owns the slash command and Home tab (so the modal lives on the Console). One bot identity per surface keeps the routing unambiguous.

**How they share state:**

- **HTTP** — The Console's modal submission `POST`s to `KRAHNBORN_API_URL/requests` with `source: 'slack-console'`. That's the only RPC between them; no shared library code.
- **Supabase** — The Console reads `pipelines` directly for the Home tab dashboard. It uses the same `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` as the orchestrator. (If the Console is ever deployed to a separate host, swap to a `GET /pipelines` endpoint here and drop the Supabase env on the Console side.)
- **Vault** — Both processes read `~/vault/clients/<name>/_index.md` from the shared filesystem. The Console's modal client dropdown is `readdirSync('~/vault/clients')` filtered to directories. The Router agent here resolves client identity from the same folders, so the dropdown stays in lockstep with what krahnborn-os understands. The Console caches the list at startup — restart to pick up new client folders.
- **No symlinks, no monorepo.** The two repos are deployment peers, not code peers.

**Why this works without a server:** the Krahn Console process runs on the same laptop as krahnborn-os, so `~/vault/` is just a filesystem read. Cloudflared tunnels public traffic to `localhost`. Move either process to a different host and the vault read becomes the next problem to solve (likely: replace with a `GET /clients` endpoint here).

## Security model

- All `/requests` and `/respond` calls require `Authorization: Bearer ${KRAHNBORN_API_TOKEN}`.
- `/slack/events` and `/github/webhook` are HMAC-verified per their respective conventions (Slack v0 signature, GitHub `X-Hub-Signature-256`).
- The agents run with `permissionMode: 'bypassPermissions'` — needed because the runtime is non-interactive. The hard rules (profile lockdown, single client repo, no `git push --force`, no `sf org delete`, scratch-target only) are enforced via prompt rules + the post-PR diff guard, not via permission prompts.
- Agent runtime is locked down via `mcpServers: {}`, `strictMcpConfig: true`, `settingSources: []` — no inherited MCPs, no inherited project settings.
