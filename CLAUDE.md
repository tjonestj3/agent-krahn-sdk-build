# Krahnborn OS

Backend pipeline that routes Salesforce client requests through specialized AI agents.

**Source of truth — read these first:**
- `krahnborn-os-architecture.md` — vision, pipeline stages, tech stack, phased rollout
- `krahnborn-os-phase-0-plan.md` — actionable step-by-step build plan for Phase 0

This file is just session-state and decisions made outside those docs.

## Where we are

**Phase 0 code is wired end-to-end.** Steps 2–7 done. Steps 3 (env), 4 (Supabase), 8 (curl test) need a human.

**What exists:**
- `src/index.ts` — Fastify boot
- `src/routes/requests.ts` — `POST /requests` handler
- `src/agents/router-agent.ts` — Router system prompt (ported from Python prototype) + tool/model config
- `src/agents/runner.ts` — `runRouter(rawRequest)` wraps `query()` and parses the final fenced JSON
- `src/db/client.ts`, `src/db/pipelines.ts` — Supabase client + pipeline/event helpers
- `src/config/env.ts` — env var validation
- `.env.example`, `.gitignore`, tuned `tsconfig.json`, `npm run dev` script

**Typecheck passes (`npx tsc --noEmit`).**

**To run Phase 0:**
1. Create a Supabase project, run the SQL block in the phase 0 plan (now includes `dev_hub_alias`).
2. Copy `.env.example` → `.env`, fill in `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
3. `npm run dev`, then `curl POST /requests` per step 8.

## Decisions made (Phase 0 open questions resolved)

- **No Salesforce MCP in Phase 0.** The Router only enumerates *local* orgs via `sf org list --json` (CLI-only thing) and globs `~/vault/clients/*/_index.md` for client identification. Salesforce MCP is a Phase 1+ concern (Execution agent reading/writing inside an org).
- **Dev Hub-only.** Per user direction (2026-04-30): the Router only ever recommends orgs with `isDevHub: true`. The actual work happens in a scratch org spun from that Dev Hub.
- **Client list = vault folders.** No hardcoded client array, no `clients` table. `~/vault/clients/<name>/_index.md` is the source of truth.
- **Hosting = local.** No VPS/Railway in Phase 0.
- **Schema tweak.** Added `dev_hub_alias text` to `pipelines`. `org_type` kept (will always be `'scratch'` in this model, but useful when Phase 1+ might also touch sandboxes).
- **No subagent wrapper for Phase 0.** The plan suggested defining the Router as an `AgentDefinition` and invoking it via a parent agent. Skipped — for one agent, that's pure overhead. `runRouter` calls `query()` directly with `systemPrompt` + `tools`. Switch to the parent/subagent pattern in Phase 1 when multiple subagents need orchestration.
- **`permissionMode: 'bypassPermissions'`** + `allowDangerouslySkipPermissions: true` so the Bash tool runs `sf org list --json` without a TTY prompt. Acceptable for Phase 0 local testing; revisit before any networked deployment.

## Known issues / deferred decisions

- `npm audit` reports 2 moderate vulns: `@anthropic-ai/sdk` 0.79.0–0.91.0 has insecure default file permissions in the memory tool (GHSA-p7fg-763f-g4gf). Phase 0 does not use the memory tool, so not blocking. The npm-suggested "fix" is a downgrade to `claude-agent-sdk@0.2.90`, which is backward — wait for a forward fix in a future SDK release before shipping anything that uses memory.
- Running `sf org list --json` returns access tokens in the JSON, which the LLM sees. Existing trade-off from the Python prototype. Acceptable for local Phase 0; for hosted Phase 2+, scrub tokens before passing to the agent or use a wrapper that returns alias-only metadata.

## Reference: Python prototype

`~/Salesforce/AGENTS/my-first-agent/TriageAgent.py` was the throwaway Python prototype. Its system prompt was ported almost verbatim into `src/agents/router-agent.ts`. Naming note: the prototype is called "Triage" but functionally it is the architecture's **Router**.
