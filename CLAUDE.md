# Krahnborn OS

Backend pipeline that routes Salesforce client requests through specialized AI agents.

**Source of truth — read these first:**
- `krahnborn-os-architecture.md` — vision, pipeline stages, tech stack, phased rollout
- `krahnborn-os-phase-0-plan.md` — actionable step-by-step build plan for Phase 0
- `wiki/system.html` (regenerate via `npm run wiki:system`) — interactive consultant-style site documenting the whole build (overview, agents, routes, DB, hard rules, ops). Source MD lives in `docs/system-wiki/`.

This file is just session-state and decisions made outside those docs.

## Where we are

**Phase 0 shipped (commit `420e3dd`).** Phase 1 milestones:
- M1 (`811b6a1`): Triage agent + pause/resume cycle.
- M2 (`7494008` + `7b9a58a`): Work Identifier agent, pre-baked Router context, MCP runtime lockdown.
- M3 (`1e9afbb`): Execution agent + scratch-org plumbing.
- M3.5 (`f499a18` async, `0e3ced6` bearer auth, `ef120b8` Slack `/events`, `6922d5c` notifier DMs, `286f785` thread-reply resume): full Slack-driven pause/resume loop.
- M4 (in progress): profile lockdown (`68adebc`), permission-set architecture (`e1e029c`), Documentation agent + GitHub PR-merge webhook (uncommitted). Pipeline is now Triage → Router → Work Identifier → Execution → (PR merged via webhook) → Documentation → `completed`.

**What exists:**
- `src/index.ts` — Fastify boot
- `src/routes/requests.ts` — `POST /requests` entry point
- `src/routes/respond.ts` — `POST /requests/:id/respond`, branches on `current_stage` (`triage` | `work_identifier`) to route the resume to the right agent
- `src/orchestrator.ts` — shared post-Triage flow: triage gate → Router → Work Identifier gate → completed. Two entry points: `processPipelineFromTriage`, `processPipelineFromWorkIdentifier`
- `src/agents/types.ts` — `AgentConfig`, `AgentResult<T>`
- `src/agents/runner.ts` — generic `runAgent<T>`, plus `run/resume` pairs for Triage, Router, Work Identifier
- `src/agents/triage-agent.ts` — Haiku, no tools, structured parse + ambiguity flagging
- `src/agents/router-agent.ts` — Sonnet 4.6, Read/Glob/Bash, Dev Hub-only, accepts Triage payload
- `src/agents/work-identifier-agent.ts` — Sonnet 4.6, no tools. Refines `change_type` into a precise `work_classification`, enumerates `metadata_changes`, sizes `story_points` (Fibonacci 1–13), captures `complexity_factors` and `execution_notes` for the Execution agent. Re-uses the same `ambiguities[]`/`blocker` pattern as Triage.
- `src/agents/execution-agent.ts` — Sonnet 4.6, tools: Read/Write/Edit/Glob/Bash, maxTurns 60, `cwd` set to the client's metadata repo (e.g. `~/Salesforce/KRAHN/Krahn-Agent-Project/`). Reads the WI spec, edits metadata XML, deploys to a scratch org, runs Apex tests, commits on a feature branch, opens a GitHub PR. Returns either `status: 'pr_opened'` (success → pipeline → `awaiting_review`) or `status: 'needs_input'` (3 retries exhausted → pipeline → `awaiting_input`).
- `src/execution/setup.ts` — `setupExecutionEnvironment(pipeline, wi)`: Node-side prep before the Execution agent runs. Loads client config, asserts clean tree, fetch+pull main, creates feature branch, spins scratch org, source-pushes main into it, sets project-local default `target-org`. Returns `ExecutionContext` for the agent.
- `src/config/clients.ts` — `loadClientConfig(name)` parses `vault/clients/<name>/_index.md` for `repo_remote`, `repo_local`, and `sf_alias`. Plain markdown key-value, not frontmatter.
- `src/db/client.ts`, `src/db/pipelines.ts` — Supabase client + pipeline/event helpers. `PipelineRow` now includes `triage_payload` and `work_identifier_payload`.
- `src/cli/triage.ts`, `src/cli/router.ts`, `src/cli/work-identifier.ts` — run any agent in isolation. The work-identifier CLI runs Triage → Router → WI in-process for a quick end-to-end taste without DB or HTTP.
- `src/cli/request.ts`, `src/cli/respond.ts` — local test loop for the pause/resume cycle. `npm run request -- "raw text"` POSTs to a running server; on pause, `npm run respond -- <pipeline_id> "answer"` resumes it. (Server must be running via `npm run dev`.) These exist *instead of* the Slack loop for now — Slack will land later when a public endpoint is ready.
- `src/cli/pipelines.ts` — list pipelines or inspect one by id
- `src/config/env.ts` — env var validation
- `db/migrations/001_add_triage_payload.sql` — Triage payload column
- `db/migrations/002_add_work_identifier_payload.sql` — Work Identifier payload column
- `db/migrations/003_add_execution_columns.sql` — Execution: `scratch_org_alias`, `branch_name`, `execution_payload`, `pr_url`
- `bin/sf-orgs-summary.sh` — slim org list (no tokens), used by Router context gathering
- `bin/spin-scratch.sh <devhub> <alias> [days]` — orchestrator-side scratch org spin, returns slim JSON
- `bin/scratch-query.sh "<soql>"` — agent-facing SOQL wrapper, strips `attributes` blocks
- `bin/scratch-describe.sh <SObject>` — agent-facing describe wrapper, returns just field shape

**Typecheck passes (`npx tsc --noEmit`).**

**To bring up M4 (full pipeline through Documentation):**
1. Run all unrun migrations in Supabase SQL editor: `004_add_slack_columns.sql`, `005_add_documentation_columns.sql` (and earlier ones if the project is fresh).
2. Make sure `gh` is authed and SSH-to-GitHub works.
3. Set `GITHUB_WEBHOOK_SECRET` in `.env` (any random string ≥ 16 chars). On the GitHub repo, configure a webhook to `POST /github/webhook` with the same secret, content-type `application/json`, subscribed to "Pull requests".
4. Working tree clean at `~/Salesforce/KRAHN/Krahn-Agent-Project/` before each request.
5. `npm run dev`. Submit via `npm run request -- "..."`; or via Slack DM (the bot DMs you on pause; reply in the thread to resume). Merging the PR fires the webhook → Documentation runs → pipeline reaches `completed` and the build record lands at `vault/clients/<client>/changes/<date>-<slug>.md`.

## Pipeline status semantics

| Status | Meaning |
|---|---|
| `running` | Agents currently executing |
| `awaiting_input` | An agent flagged a blocker ambiguity; needs human answer before proceeding. Check `current_stage` to know which agent paused. |
| `awaiting_review` | Execution opened a PR. Pipeline waits here until the GitHub PR-merge webhook fires. The diff guard rejects any PR touching Profile metadata (closes the PR, resets the branch, pauses to `awaiting_input`). |
| `completed` | Documentation agent has written the build record to `vault/clients/<client>/changes/<date>-<slug>.md`. Terminal. |
| `failed` | An agent or orchestrator step threw; see `pipeline_events.event_type = 'stage_failed'` for the error |

`current_stage` values you may see: `'triage'`, `'work_identifier'`, `'execution'`, `'documentation'`. (Router doesn't pause; the GitHub webhook flips `awaiting_review` → `running` with `current_stage='documentation'`.)

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
- Running `sf org list --json` returns access tokens in the JSON. Resolved in M2 by `bin/sf-orgs-summary.sh` which strips tokens before output reaches the LLM. Use it (and the other `bin/scratch-*.sh` wrappers) instead of raw `sf` whenever the output goes to a model.
- **Concurrency:** M3 assumes one pipeline at a time per client repo. `setupExecutionEnvironment` writes the scratch alias into `<repo>/.sf/config.json` as the project-local default `target-org`; two pipelines on the same repo would stomp each other. Defer to M4 (git worktrees + per-pipeline config).
- **No automatic scratch teardown.** Scratch orgs spun by M3 live for 7 days (the default) and then auto-expire on the Dev Hub. If you need to free a Dev Hub slot earlier, `sf org delete --target-org <alias>` manually. The Execution agent is forbidden from deleting orgs.

## Reference: Python prototype

`~/Salesforce/AGENTS/my-first-agent/TriageAgent.py` was the throwaway Python prototype. Its system prompt was ported almost verbatim into `src/agents/router-agent.ts`. Naming note: the prototype is called "Triage" but functionally it is the architecture's **Router**.
