---
title: Orchestrator state machine
slug: orchestrator
group: Technical
order: 5
---

# Orchestrator state machine

The Fastify process is the conductor. `src/orchestrator.ts` exposes four entry points:

1. `processPipelineFromTriage(pipeline, triage)` — called by `routes/requests.ts` after the initial Triage run, and by the resume path after a Triage pause.
2. `processPipelineFromWorkIdentifier(pipeline, wi)` — called by the resume path after a Work Identifier pause.
3. `processPipelineFromExecution(pipeline, exec)` — called by the resume path after an Execution pause.
4. `processPipelineFromMerge(pipeline)` — called by `routes/github.ts` after a PR merge webhook.

Each entry point picks up at the right point in the state machine.

## States

| State | What it means | Active stage |
|---|---|---|
| `running` | An agent is currently executing | `triage`, `router`, `work_identifier`, `execution`, `documentation` |
| `awaiting_input` | Paused on a blocker; needs a human reply | one of the above |
| `awaiting_review` | Execution opened a PR; waiting for merge | – |
| `completed` | Documentation written; terminal | – |
| `failed` | An agent or orchestrator step threw | – |

## Transitions

```
   created
      │
      ▼
   running (triage) ──► awaiting_input ──┐
      │                                  │
      ▼                                  │
   running (router)  ◄────────────────────┘
      │
      ▼
   running (work_identifier) ──► awaiting_input ──┐
      │                                            │
      ▼                                            │
   running (execution) ◄───────────────────────────┘
      │
      ├─► needs_input ──► awaiting_input (execution) ──┐
      │                                                 │
      ├─► diff_guard_violation ──► awaiting_input (execution) ──┐
      │                                                          │
      ▼                                                          ▼
   awaiting_review                                          (resume)
      │
      ▼ (PR merged via webhook)
   running (documentation)
      │
      ▼
   completed

(any running) ──► failed
```

## Gates

After each stage, the orchestrator runs a small gate function:

- After Triage: `triageHasBlocker(payload)` — pause if any `ambiguities[].blocker === true`.
- After Router: no gate. Always proceeds.
- After Work Identifier: `workIdentifierHasBlocker(payload)` — same check.
- After Execution: branches on `payload.status`. `needs_input` pauses; `pr_opened` runs the diff guard, then either pauses again (on violation) or transitions to `awaiting_review`.
- After Documentation: `completed`.

## Concurrency

Active execution phases acquire a per-`client_id` mutex via `withClientRepoLock(client_id, fn)` (see `src/execution/repo-lock.ts`). Setup + run for a fresh request is one critical section; resume is another. Pauses release the lock; resume re-acquires.

## Telemetry

Every successful stage logs both `stage_completed` (with the agent's payload) and `stage_telemetry` (with the SDK's `result` message: turns, tokens, cost). The CLI sums these per pipeline.

## Error handling

Each entry point catches throws, marks `status = 'failed'`, logs `stage_failed`, and DMs the human. `notifyFailed` errors are swallowed — observability problems must not turn into pipeline-state problems.
