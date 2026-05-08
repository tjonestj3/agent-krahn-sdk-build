---
title: Agent specs
slug: agents
group: Technical
order: 2
---

# Agent specs

Five agents. Each is a fresh `query()` invocation against the Anthropic SDK with its own system prompt. No subagent wrapper, no `Task` tool — the Fastify orchestrator is the conductor and calls each stage in sequence.

Common runtime options (in `src/agents/runner.ts`):

- `mcpServers: {}` + `strictMcpConfig: true` — no inherited MCPs land in the agent's runtime.
- `settingSources: []` — no inherited project settings.
- `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` — the orchestrator runs with no TTY; permission prompts would deadlock.
- `tools: [...]` + `allowedTools: [...]` — only the listed tools are available.

## Triage

| | |
|---|---|
| File | `src/agents/triage-agent.ts` |
| Model | `claude-haiku-4-5-20251001` |
| Tools | none |
| Max turns | 3 |
| Output | `TriagePayload` |

Pure parsing. Returns `summary`, `change_type` (one of a small enum), `salesforce_objects[]`, `urgency`, `deadline`, `client_hints[]`, `attachments`, `ambiguities[]`. Crucially: it does NOT canonicalize the client and does NOT propose any work. It only flags. Access-grant intent is left as intent, never restated as "update Profile X".

Pauses when `ambiguities[].blocker === true`.

## Router

| | |
|---|---|
| File | `src/agents/router-agent.ts` |
| Model | `claude-sonnet-4-6` |
| Tools | `Read`, `Glob`, `Bash` (limited) |
| Max turns | small |
| Output | `RouterPayload` |

Identifies the canonical client and the Dev Hub. Pre-baked context: `bin/sf-orgs-summary.sh` provides a token-stripped org list, and the agent globs `~/vault/clients/*/_index.md`. **Dev-Hub-only**: the prompt forbids recommending non-Dev-Hub orgs.

Does NOT pause. At any confidence level it returns its best recommendation; downstream stages may flag low confidence as a blocker.

## Work Identifier

| | |
|---|---|
| File | `src/agents/work-identifier-agent.ts` |
| Model | `claude-sonnet-4-6` |
| Tools | none |
| Max turns | 3 |
| Output | `WorkIdentifierPayload` |

Refines the coarse `change_type` into a precise `work_classification`. Enumerates `metadata_changes[]` (object/field/operation/notes) and `permission_grants[]` (per-permset, with strategy + field + object grants). Sizes via Fibonacci `story_points`. Captures `complexity_factors[]` and a 2–4 sentence `execution_notes` paragraph aimed at the next agent.

Reads the per-client role permset registry from the user prompt (built from `loadClientConfig().permission_sets`). Required to extend an existing role permset before proposing a new one. `permission_strategy: "create_new"` always produces a blocker ambiguity.

Pauses when `ambiguities[].blocker === true`.

## Execution

| | |
|---|---|
| File | `src/agents/execution-agent.ts` |
| Model | `claude-sonnet-4-6` |
| Tools | `Read`, `Write`, `Edit`, `Glob`, `Bash`, `Agent` (for scout dispatch) |
| Subagents | `scout` (read-only investigation, Haiku 4.5, 18 turns, `sf-read` MCP) |
| Max turns | 60 |
| `cwd` | client metadata repo |
| Output | `ExecutionPayload` |

The first agent with real-world side effects. Receives the prior payloads + an `ExecutionContext` (branch name, scratch alias, scratch login URL, repo path) prepared by the orchestrator. Walks the spec: edits XML, deploys, retries up to 3 times per failure, runs tests, commits to a feature branch, opens a PR via `gh`.

Returns either `status: "pr_opened"` (success) or `status: "needs_input"` (3 retries exhausted). On `needs_input`, the agent's `attempts[]` and a fresh `ambiguities[]` capture the failure mode for the human.

The agent has hard prompt rules forbidding: pushing to/checking out main, targeting any org but the scratch alias, `sf org delete`/`org logout`/`git reset --hard`/`git push --force`, edits outside `force-app/`, and **any edit to profile metadata**.

After a successful PR, the orchestrator's diff guard re-checks for forbidden paths; a violating PR is closed, the branch is reset, and the pipeline pauses for retry.

### Scout subagent

Execution can dispatch a `scout` subagent via the `Agent` tool. Scout has `Read`, `Glob`, `Bash`, and the `sf-read` MCP tools (`mcp__sf-read__soqlQuery`, `mcp__sf-read__describeSObject`). It has no `Write` or `Edit`, runs on Haiku 4.5 with an 18-turn budget, and is forbidden from any state-changing operation (no deploys, no commits, no PRs, no profile reads, no DML against any org including prod).

Org reads go through the `sf-read` MCP server, not through bash:

- `mcp__sf-read__soqlQuery({ soql, alias? })` — read-only SOQL SELECT. Pass `alias` (the client's prod / Dev Hub alias from `execution_context.dev_hub_alias`) to query prod; omit `alias` to query the project default target-org (the scratch). Returns slim `{ totalSize, done, records[] }` with internal `attributes` blocks stripped.
- `mcp__sf-read__describeSObject({ sobject, alias? })` — describe an SObject. Same alias convention. Returns `{ name, label, custom, fields[] }`; each field has `name`, `label`, `type`, `custom`, `nillable`, optional `referenceTo`, optional `relationshipName` for reference fields, and `picklistValues` (a string array when label==value for all entries; an array of `{label, value}` objects when any differ).

Bash is still available for the non-Salesforce reads: `gh pr view/diff`, `git log/diff/show/status`, `ls/find/wc`. Scout's prompt explicitly forbids using Bash to call `sf` directly — the MCP is the only sanctioned org-read path.

Why prod-read matters: the scratch is freshly built from `main`, which lags reality. A field added in prod via Setup but never sourced won't be in the scratch. Before the parent commits to an API name or assumes a field doesn't exist, it should dispatch the scout to check prod. This dramatically reduces "deploy succeeds in scratch, fails after merge to prod" surprises.

Use cases: "Does `Annual_Contract_Value__c` already exist on Opportunity in prod?", listing entries in a permission set XML, finding existing Apex test classes that touch a given object, scanning recent `git log` for related changes, running a SOQL or describe whose raw output would otherwise be 50KB+ in the parent's context.

The scout returns a concise plain-text summary (≤ 30 lines), preserving the parent's context window for the actual edit/deploy/commit work. Subagent token + cost usage rolls up into the parent's stage telemetry. The `sf-read` MCP server is spawned per pipeline run; it dies when the agent SDK shuts down.

## Documentation

| | |
|---|---|
| File | `src/agents/documentation-agent.ts` |
| Model | `claude-sonnet-4-6` |
| Tools | `Read`, `Glob`, `Write`, `Bash` (for `gh pr view/diff`) |
| Max turns | 15 |
| `cwd` | client metadata repo |
| Output | `DocumentationPayload` |

Triggered by the GitHub PR-merge webhook. Reads the merged PR via `gh`, then writes a single markdown file to `~/vault/clients/<client>/changes/<date>-<slug>.md` following a fixed template (frontmatter + summary + schema/access/code sections + verification + rollback + build trail + decisions).

Forbidden from editing code, opening PRs, or running mutating `git` commands. Documentation only.
