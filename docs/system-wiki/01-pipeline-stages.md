---
title: Pipeline stages
slug: pipeline-stages
group: How it works
order: 1
---

# Pipeline stages

The pipeline is five sequential stages plus two human-in-the-loop transitions (pause-and-resume on ambiguity, and PR-merge → documentation).

## Stage 1: Triage

| Field | Value |
|---|---|
| Model | `claude-haiku-4-5` |
| Tools | none |
| Max turns | 3 |
| Side effects | none |

Parses the raw request into a structured payload: `summary`, `change_type`, `salesforce_objects`, `urgency`, `deadline`, `client_hints`, `ambiguities`. Triage does not identify the canonical client — that is the Router's job. It only parses and flags.

If `ambiguities[]` contains a `blocker: true` entry, the pipeline pauses to `awaiting_input` and DMs the human.

## Stage 2: Router

| Field | Value |
|---|---|
| Model | `claude-sonnet-4-6` |
| Tools | `Read`, `Glob`, `Bash` (`bin/sf-orgs-summary.sh` only) |
| Max turns | small |
| Side effects | reads vault `_index.md` files; runs `sf org list --json` indirectly |

Picks the client (looking at `vault/clients/*/_index.md`) and the Dev Hub. Always emits a single recommended Dev Hub. Router does not pause — even at low confidence it returns its best guess. The Work Identifier later may flag low confidence as a blocker if it would change the work.

## Stage 3: Work Identifier

| Field | Value |
|---|---|
| Model | `claude-sonnet-4-6` |
| Tools | none |
| Max turns | 3 |
| Side effects | none |

Refines the coarse Triage `change_type` into a precise `work_classification`. Enumerates `metadata_changes[]`, sizes via Fibonacci `story_points`, captures `complexity_factors`, and emits `permission_grants[]` with a `permission_strategy` of `extend_existing` or `create_new` (or `none` for pure schema work).

Work Identifier reads the per-client role permset registry and is required to extend an existing role permset before proposing a new one. `create_new` always produces a blocker ambiguity so the human confirms the new permset name and role.

If a blocker is emitted, the pipeline pauses to `awaiting_input` (current_stage: `work_identifier`).

## Stage 4: Execution

| Field | Value |
|---|---|
| Model | `claude-sonnet-4-6` |
| Tools | `Read`, `Write`, `Edit`, `Glob`, `Bash` |
| Max turns | 60 |
| Side effects | edits metadata XML, deploys to scratch, runs tests, commits, pushes, opens GitHub PR |

The orchestrator has already prepared the environment: cloned/synced the client repo, fetched + pulled main, created a feature branch, spun a fresh scratch org, source-pushed main into it, and set the scratch as the project-local default `target-org`. The agent's `cwd` is the repo root.

Execution applies the Work Identifier's spec — schema mutations via Edit/Write on metadata XML, permission grants by extending the named permset XML — then deploys, tests, commits, pushes, and opens a PR. Up to 3 retries per failing operation; after 3 it emits `needs_input` and the pipeline pauses.

On `pr_opened`, the orchestrator runs a post-PR diff guard. If any path is forbidden (currently: profile XML), the guard closes the PR via `gh pr close`, force-resets the feature branch to `origin/main`, and pauses the pipeline so the agent can be resumed with the violation as its prompt.

## Stage 5: Documentation

| Field | Value |
|---|---|
| Model | `claude-sonnet-4-6` |
| Tools | `Read`, `Glob`, `Write`, `Bash` (for `gh pr view/diff`) |
| Max turns | 15 |
| Side effects | writes one markdown file under `~/vault/clients/<client>/changes/` |

Triggered by the GitHub PR-merge webhook. Reads the prior payloads + the merged PR diff, writes a structured build record following a fixed template (see [Build record template](#)). Pipeline reaches `completed`.

## Status transitions

```
running → (triage blocker) → awaiting_input → running → (router) → running → (wi blocker) → awaiting_input → running → (execution) → awaiting_review → (PR merged) → running → (documentation) → completed
```

`failed` is reachable from any `running` state when an agent or orchestrator step throws.
