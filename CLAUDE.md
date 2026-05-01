# Krahnborn OS

Backend pipeline that routes Salesforce client requests through specialized AI agents.

**Source of truth — read these first:**
- `krahnborn-os-architecture.md` — vision, pipeline stages, tech stack, phased rollout
- `krahnborn-os-phase-0-plan.md` — actionable step-by-step build plan for Phase 0

This file is just session-state and decisions made outside those docs.

## Where we are

**Phase 0 shipped (commit `420e3dd`).** Phase 1 milestones:
- M1 (committed `811b6a1`): Triage agent + pause/resume cycle.
- M2 (uncommitted): **Work Identifier agent** added. Pipeline is now Triage → Router → Work Identifier, each capable of pausing and resuming on its own blockers.

**What exists:**
- `src/index.ts` — Fastify boot
- `src/routes/requests.ts` — `POST /requests` entry point
- `src/routes/respond.ts` — `POST /requests/:id/respond`, branches on `current_stage` (`triage` | `work_identifier`) to route the resume to the right agent
- `src/orchestrator.ts` — shared post-Triage flow: triage gate → Router → Work Identifier gate → completed. Two entry points: `processPipelineFromTriage`, `processPipelineFromWorkIdentifier`
- `src/agents/types.ts` — `AgentConfig`, `AgentResult<T>`
- `src/agents/runner.ts` — generic `runAgent<T>`, plus `run/resume` pairs for Triage, Router, Work Identifier
- `src/agents/triage-agent.ts` — Haiku, no tools, structured parse + ambiguity flagging
- `src/agents/router-agent.ts` — Sonnet 4.6, Read/Glob/Bash, Dev Hub-only, accepts Triage payload
- `src/agents/work-identifier-agent.ts` — Sonnet 4.6, no tools. Refines `change_type` into a precise `work_classification`, enumerates `metadata_changes`, sizes `story_points` (Fibonacci 1–13), captures `complexity_factors` and `execution_notes` for the future Execution agent. Re-uses the same `ambiguities[]`/`blocker` pattern as Triage.
- `src/db/client.ts`, `src/db/pipelines.ts` — Supabase client + pipeline/event helpers. `PipelineRow` now includes `triage_payload` and `work_identifier_payload`.
- `src/cli/triage.ts`, `src/cli/router.ts`, `src/cli/work-identifier.ts` — run any agent in isolation. The work-identifier CLI runs Triage → Router → WI in-process for a quick end-to-end taste without DB or HTTP.
- `src/cli/request.ts`, `src/cli/respond.ts` — local test loop for the pause/resume cycle. `npm run request -- "raw text"` POSTs to a running server; on pause, `npm run respond -- <pipeline_id> "answer"` resumes it. (Server must be running via `npm run dev`.) These exist *instead of* the Slack loop for now — Slack will land later when a public endpoint is ready.
- `src/cli/pipelines.ts` — list pipelines or inspect one by id
- `src/config/env.ts` — env var validation
- `db/migrations/001_add_triage_payload.sql` — Triage payload column
- `db/migrations/002_add_work_identifier_payload.sql` — Work Identifier payload column

**Typecheck passes (`npx tsc --noEmit`).**

**To bring up M2:**
1. Run `db/migrations/002_add_work_identifier_payload.sql` in Supabase SQL editor.
2. Restart `npm run dev`.
3. `npm run request -- "your raw request"` — happy path returns `{ status: 'completed', triage, routed, work_identifier }`. Blocker path returns `{ status: 'awaiting_input', stage, blockers, ... }` and prints the resume command.

## Pipeline status semantics

## Pipeline status semantics

| Status | Meaning |
|---|---|
| `running` | Agents currently executing |
| `awaiting_input` | An agent flagged a blocker ambiguity; needs human answer before proceeding. Check `current_stage` to know which agent paused. |
| `awaiting_review` | (Phase 2+) PR open, awaiting human review |
| `completed` | All stages finished cleanly |
| `failed` | An agent threw; see `pipeline_events.event_type = 'stage_failed'` for the error |

`current_stage` values you may see while paused: `'triage'`, `'work_identifier'`. (Router doesn't pause yet — it always returns a routed payload, even at low confidence.)

## Decisions made (Phase 0 open questions resolved)

- **No Salesforce MCP in Phase 0.** The Router only enumerates *local* orgs via `sf org list --json` (CLI-only thing) and globs `~/vault/clients/*/_index.md` for client identification. Salesforce MCP is a Phase 1+ concern (Execution agent reading/writing inside an org).
- **Dev Hub-only.** Per user direction (2026-04-30): the Router only ever recommends orgs with `isDevHub: true`. The actual work happens in a scratch org spun from that Dev Hub.
- **Client list = vault folders.** No hardcoded client array, no `clients` table. `~/vault/clients/<name>/_index.md` is the source of truth.
- **Hosting = local.** No VPS/Railway in Phase 0.
- **Schema tweak.** Added `dev_hub_alias text` to `pipelines`. `org_type` kept (will always be `'scratch'` in this model, but useful when Phase 1+ might also touch sandboxes).
- **No SDK subagent wrapper.** The plan suggested defining each agent as an `AgentDefinition` and invoking via a parent agent that uses `Task`. Skipped — for deterministic sequencing (Triage → Router → ...), the orchestration server (Fastify route) is the conductor, calling `query()` directly per stage. The architecture doc explicitly endorses this ("Start with explicit sequencing. Move to LLM orchestration when the workflow gets variable enough to need it."). Revisit when an agent's order-of-operations actually depends on prior agents' output in non-trivial ways.
- **`permissionMode: 'bypassPermissions'`** + `allowDangerouslySkipPermissions: true` so the Bash tool runs `sf org list --json` without a TTY prompt. Acceptable for Phase 0 local testing; revisit before any networked deployment.

## Known issues / deferred decisions

- `npm audit` reports 2 moderate vulns: `@anthropic-ai/sdk` 0.79.0–0.91.0 has insecure default file permissions in the memory tool (GHSA-p7fg-763f-g4gf). Phase 0 does not use the memory tool, so not blocking. The npm-suggested "fix" is a downgrade to `claude-agent-sdk@0.2.90`, which is backward — wait for a forward fix in a future SDK release before shipping anything that uses memory.
- Running `sf org list --json` returns access tokens in the JSON, which the LLM sees. Existing trade-off from the Python prototype. Acceptable for local Phase 0; for hosted Phase 2+, scrub tokens before passing to the agent or use a wrapper that returns alias-only metadata.

## Reference: Python prototype

`~/Salesforce/AGENTS/my-first-agent/TriageAgent.py` was the throwaway Python prototype. Its system prompt was ported almost verbatim into `src/agents/router-agent.ts`. Naming note: the prototype is called "Triage" but functionally it is the architecture's **Router**.
