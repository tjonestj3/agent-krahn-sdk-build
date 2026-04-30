# Krahnborn OS

Backend pipeline that routes Salesforce client requests through specialized AI agents.

**Source of truth — read these first:**
- `krahnborn-os-architecture.md` — vision, pipeline stages, tech stack, phased rollout
- `krahnborn-os-phase-0-plan.md` — actionable step-by-step build plan for Phase 0

This file is just session-state and decisions made outside those docs.

## Where we are

**Phase 0 shipped (commit `420e3dd`).** Phase 1 in progress: **Triage → Router orchestration is wired** (uncommitted at the time of this update).

**What exists:**
- `src/index.ts` — Fastify boot
- `src/routes/requests.ts` — `POST /requests` orchestrator: Triage → blocker gate → Router
- `src/agents/types.ts` — `AgentConfig`, `AgentResult<T>`
- `src/agents/runner.ts` — generic `runAgent<T>(config, prompt)`, plus `runTriage`/`runRouter` wrappers
- `src/agents/triage-agent.ts` — Haiku, no tools, structured parse + ambiguity flagging
- `src/agents/router-agent.ts` — Sonnet 4.6, Read/Glob/Bash, Dev Hub-only, accepts Triage payload
- `src/db/client.ts`, `src/db/pipelines.ts` — Supabase client + pipeline/event helpers (now includes `triage_payload`)
- `src/cli/router.ts`, `src/cli/triage.ts` — run either agent in isolation
- `src/config/env.ts` — env var validation
- `db/migrations/001_add_triage_payload.sql` — SQL for the new column
- `.env.example`, `.gitignore`, tuned `tsconfig.json`, `npm run dev` / `npm run router` / `npm run triage` scripts
- `docs/phase-0-overview.html` — single-page walkthrough of the build

**Typecheck passes (`npx tsc --noEmit`).**

**To bring up the new orchestration:**
1. Run `db/migrations/001_add_triage_payload.sql` in Supabase SQL editor.
2. Restart `npm run dev`.
3. `curl POST /requests` — response now includes both `triage` and `routed` keys.

## Pipeline status semantics

| Status | Meaning |
|---|---|
| `running` | Agents currently executing |
| `awaiting_input` | Triage flagged a blocker ambiguity; needs human answer before proceeding |
| `awaiting_review` | (Phase 2+) PR open, awaiting human review |
| `completed` | All stages finished cleanly |
| `failed` | An agent threw; see `pipeline_events.event_type = 'stage_failed'` for the error |

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
