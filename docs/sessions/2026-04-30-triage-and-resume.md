# 2026-04-30 — Triage agent + resume cycle

**Phase 1 milestone 1.** First multi-agent orchestration. First pause/resume across a real human-in-the-loop gap.

## What got built

- **Triage agent** (`src/agents/triage-agent.ts`) — Haiku 4.5, no tools, pure text-to-structured-JSON. Parses raw_request into `summary`, `change_type`, `salesforce_objects`, `urgency`, `deadline`, `client_hints`, `attachments`, `ambiguities[]`.
- **Generic agent runner** (`src/agents/runner.ts`) — refactored from per-agent `runRouter` into `runAgent<T>(config, prompt, opts)` with a `resume?: string` passthrough. Thin `runTriage` / `runRouter` / `resumeTriage` wrappers on top.
- **Orchestrator** (`src/orchestrator.ts`) — shared post-Triage logic. Both `POST /requests` and `POST /requests/:id/respond` produce a Triage result, then hand off to `processPipelineFromTriage()` which handles blocker gate → Router → final state.
- **Resume endpoint** (`src/routes/respond.ts`) — `POST /requests/:id/respond` with `{ answer: string }`. Validates `awaiting_input`, atomically claims the row (`claimForRunning` flips status with optimistic lock), resumes Triage from saved `session_id`.
- **Schema migration** (`db/migrations/001_add_triage_payload.sql`) — adds `triage_payload jsonb` to `pipelines`. Already applied to live Supabase.
- **Pipelines CLI** (`src/cli/pipelines.ts`) — `npm run pipelines` lists recent rows; `npm run pipelines -- <uuid>` shows a full row + last 50 events. Useful for debugging without the dashboard.
- **Triage CLI** (`src/cli/triage.ts`) — runs Triage in isolation, like the existing router CLI.

## End-to-end verification

Ran a full cycle on pipeline `12138953-dc26-4031-9e80-654b7132dec4`:

| Stage | Time | Note |
|---|---|---|
| Initial POST | 20:24:14 | "Add Account_Tier__c picklist (Bronze/Silver/Gold) to Lead for NRI" |
| Triage finished | 20:24:43 | Flagged blocker: "required or optional?" |
| Status → awaiting_input | 20:24:44 | |
| **Dormant gap** | 20:24 → 22:30 | ~2 hours. Server kept running. No pipeline polling, no process babysitting. |
| Human response | 22:30:38 | "Make it optional, no validation rule needed." |
| Triage resumed | 22:30:38 → 22:30:47 | 9 seconds — agent had full prior context via session_id |
| Router started | 22:30:47 | Got Triage payload as input alongside raw_request |
| Router done | 22:32:35 | client="nri", dev_hub="krahn", confidence="high" |

Notable: Router was *more confident* this time than the original Phase 0 test (which returned `medium` confidence with two options + null Dev Hub). The Triage payload genuinely improved Router's accuracy. That validates the option-B design (raw_request canonical + Triage payload as enrichment).

## Key decisions

1. **Explicit sequencing in the route, not LLM orchestration.** No parent agent using `Task`. Architecture doc explicitly endorses this for fixed pipelines. Makes ordering deterministic and debuggable. Revisit if/when an agent's order-of-operations becomes data-dependent in non-trivial ways.

2. **Generic `runAgent<T>`.** Both Triage and Router go through one runner. Adding the next agent (Work Identifier) is now: write `*-agent.ts` with config + payload type, write a wrapper, call it from the orchestrator.

3. **`option B` for Triage→Router handoff.** Raw request stays canonical in `pipelines.raw_request`. Triage payload lives alongside in `pipelines.triage_payload jsonb`. Router gets *both* in its user prompt. More state to manage, way better debuggability — and the confidence bump above is direct evidence it pays off.

4. **Optimistic concurrency on resume.** `claimForRunning(id)` flips status `awaiting_input → running` with an `eq('status', 'awaiting_input')` guard. If two `/respond` calls hit the same pipeline simultaneously, only one wins. The other gets a 409.

5. **`session_id` is the resume primitive.** SDK's `options.resume` reloads the entire conversation. We store the *most recent* session_id on the row — during pause, that's Triage's session; after resume completes and Router runs, it's Router's session. `current_stage` tells us which agent's session is active.

6. **Status during resume is `running`, not `resuming`.** The state machine has no `resuming` state. While the human's answer is being processed, status is `running`, exactly like the initial flow. Keeps the state space small.

## What's NOT done

- **Slack notifier.** When status flips to `awaiting_input`, nothing pings the human. Right now the only way to see a paused pipeline is the Supabase dashboard or `npm run pipelines awaiting_input`. The `/respond` endpoint shape is already Slack-friendly: `POST /requests/:id/respond` with `{ answer: string }` is exactly what a Slack bot will call after a thread reply.
- **Resume for stages other than Triage.** `routes/respond.ts` returns 501 if `current_stage !== 'triage'`. Router doesn't pause yet (no AskUserQuestion in its tool list, intentionally). When Work Identifier or Execution can pause, generalize the resume dispatch.
- **Work Identifier agent.** Phase 1 next stage. Per architecture: classify the work (Flow / Apex / LWC / Omni-Channel / doc-only), size with the Krahnborn story point Skill, decide attempt-vs-escalate.
- **Execution agent.** Phase 1 endpoint stage. Spins scratch org from the recommended Dev Hub, applies the change via SFDX CLI, opens PR.

## Pointers for the next session

- **State reference:** `CLAUDE.md` is the canonical "where we are" doc. Keep it updated.
- **API contract:** `POST /requests` (create), `POST /requests/:id/respond` (resume), `GET /health`. No GET /requests yet — use `npm run pipelines` for now.
- **Agent inventory:** `src/agents/{triage,router}-agent.ts`. Each exports a `*_CONFIG` and a payload type. `runner.ts` wraps both.
- **Adding the next agent:** template = look at `triage-agent.ts` (no tools) or `router-agent.ts` (with tools). Add a wrapper in `runner.ts`. Add a stage to `orchestrator.ts`. Add a column to `pipelines` if its output needs to be queryable (otherwise live in events log).
- **The "why" docs:** `krahnborn-os-architecture.md` (vision), `krahnborn-os-phase-0-plan.md` (now also has Phase 1 schema), `docs/phase-0-overview.html` (single-page walkthrough — slightly stale now since Triage is wired, but the mental model still applies).

## Open question to think about

What's the right next move?
- **(a) Slack notifier** — closes the operational loop. Makes the system actually usable instead of "remember to check the dashboard."
- **(b) Work Identifier** — extends the agent chain. More technical depth, but no operational payoff until (a) lands.
- **(c) Execution** — biggest jump, requires SFDX CLI integration + GitHub MCP + scratch org provisioning. Real work output, but lots of unknowns.

Recommendation: probably (a) first — small surface, immediate value, makes (b)/(c) actually useful. But your call.
