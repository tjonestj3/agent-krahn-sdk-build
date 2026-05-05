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

## Security model

- All `/requests` and `/respond` calls require `Authorization: Bearer ${KRAHNBORN_API_TOKEN}`.
- `/slack/events` and `/github/webhook` are HMAC-verified per their respective conventions (Slack v0 signature, GitHub `X-Hub-Signature-256`).
- The agents run with `permissionMode: 'bypassPermissions'` — needed because the runtime is non-interactive. The hard rules (profile lockdown, single client repo, no `git push --force`, no `sf org delete`, scratch-target only) are enforced via prompt rules + the post-PR diff guard, not via permission prompts.
- Agent runtime is locked down via `mcpServers: {}`, `strictMcpConfig: true`, `settingSources: []` — no inherited MCPs, no inherited project settings.
