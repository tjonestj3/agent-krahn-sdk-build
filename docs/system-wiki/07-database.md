---
title: Database
slug: database
group: Technical
order: 4
---

# Database

Two tables. State lives in `pipelines`; history lives in `pipeline_events`. No client table — clients are folders in `~/vault/clients/`.

## `pipelines`

One row per request. Migrations build it up incrementally; the current shape:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `source` | text | `manual`, `slack`, etc |
| `raw_request` | text | verbatim user input |
| `client_id` | text | the folder name in `vault/clients/`; null until Router runs |
| `org_type` | text | always `scratch` in this model |
| `dev_hub_alias` | text | the Dev Hub the scratch was spun from |
| `triage_payload` | jsonb | full `TriagePayload` |
| `work_identifier_payload` | jsonb | full `WorkIdentifierPayload` |
| `execution_payload` | jsonb | full `ExecutionPayload` |
| `documentation_payload` | jsonb | full `DocumentationPayload` |
| `documentation_path` | text | absolute path to the build record |
| `scratch_org_alias` | text | set by orchestrator setup |
| `branch_name` | text | set by orchestrator setup |
| `pr_url` | text | set by Execution; may be cleared by the diff guard |
| `github_pr_number` | int | set when the merge webhook fires |
| `merged_at` | timestamptz | set when the merge webhook fires |
| `slack_channel_id` | text | DM channel for the pipeline's thread |
| `slack_message_ts` | text | root ts of the Slack thread |
| `status` | text | one of `running` / `awaiting_input` / `awaiting_review` / `completed` / `failed` |
| `session_id` | text | the Anthropic SDK session id of the most recent agent run; used to resume |
| `current_stage` | text | which agent is/was active; null when terminal |
| `created_at` | timestamptz | default `now()` |
| `updated_at` | timestamptz | bumped on every update |

Indexes: `pr_url` (partial), `github_pr_number` (partial), `slack_message_ts` (partial). All `WHERE column IS NOT NULL` so the index stays small.

## `pipeline_events`

Append-only audit log. One row per event. Common types:

| Event type | Stage | Payload |
|---|---|---|
| `created` | – | `{ source }` |
| `stage_started` | any | – |
| `stage_completed` | any | the stage's full payload |
| `stage_telemetry` | any | `{ agent, model, num_turns, total_cost_usd, input_tokens, output_tokens, cache_*_tokens }` |
| `awaiting_input` | any | `{ blockers, blocked_on? }` |
| `human_response` | any | `{ answer }` |
| `stage_resumed` | any | – |
| `execution_setup_done` | execution | `{ scratch_org_alias, branch_name, scratch_org_id }` |
| `diff_guard_violation` | execution | `{ violations, changed_files }` |
| `pr_merged` | documentation | `{ pr_url, pr_number, merged_at }` |
| `stage_failed` | any | `{ error, while? }` |

Read with `SELECT ... ORDER BY created_at ASC` for a full pipeline trace. `cli/pipelines.ts` fetches the last 100 events for the detail view.

## Migrations

```
db/migrations/001_add_triage_payload.sql
db/migrations/002_add_work_identifier_payload.sql
db/migrations/003_add_execution_columns.sql
db/migrations/004_add_slack_columns.sql
db/migrations/005_add_documentation_columns.sql
```

Run them in order in the Supabase SQL editor. Each is `CREATE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` so re-running is safe.

## Why no clients table

The pipeline reads client metadata from `~/vault/clients/<name>/_index.md`. That file is the source of truth for `repo_remote`, `repo_local`, `sf_alias`, and the role permset registry. A separate DB table would mean two places to keep in sync; the vault is already the *why* layer for these projects.
