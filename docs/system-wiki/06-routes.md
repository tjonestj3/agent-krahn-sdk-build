---
title: HTTP routes
slug: routes
group: Technical
order: 3
---

# HTTP routes

All routes registered in `src/index.ts`. Bearer-auth middleware applies globally except for `/health`, `/slack/*`, and `/github/*`. Public routes carry their own HMAC verification.

## `GET /health`

Liveness probe. Returns `{ status: 'ok' }`. No auth. Always 200.

## `POST /requests`

Create a new pipeline.

| | |
|---|---|
| Auth | Bearer |
| Body | `{ source?: string, raw_request: string }` |
| Returns | `202` with `{ pipeline_id, status, current_stage, pipeline }` |

Inserts a row, logs `created`, fires Triage in the background. The caller is expected to poll `GET /requests/:id` (or wait for a Slack DM) to learn what happened.

## `GET /requests/:id`

Inspect a pipeline.

| | |
|---|---|
| Auth | Bearer |
| Returns | `{ pipeline, events }` (most-recent 50 events) |

## `POST /requests/:id/respond`

Resume a paused pipeline by answering its blocker.

| | |
|---|---|
| Auth | Bearer |
| Body | `{ answer: string }` |
| Returns | `202` on success; `404` not found; `409` not paused; `501` unsupported stage |

Calls `claimAndResume()` which atomically flips `awaiting_input → running`, logs `human_response`, and fires the appropriate resume in the background. Used by `npm run respond` and (eventually) any HTTP-based UI.

## `POST /slack/events`

Inbound Slack events. Verified via `X-Slack-Signature` (v0 HMAC-SHA256) against `SLACK_SIGNING_SECRET` with a 5-minute timestamp window.

Handles:
- `url_verification` — returns the challenge.
- `event_callback` for `message` events that are DMs (`channel_type === 'im'`), not bot, not subtyped, with text and a `thread_ts`. Looks up the pipeline by `slack_message_ts`, calls `claimAndResume()`. Top-level DMs and unknown threads get a friendly auto-reply.

Acks fast (`200`) and processes async; Slack's 3-second deadline is respected.

## `POST /github/webhook`

Inbound GitHub webhook. Verified via `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`.

Only acts on `pull_request` events with `action: 'closed'` and `pull_request.merged === true`. Looks up the pipeline by `pr_url` (then `pr_number`), atomically claims `awaiting_review → running` with `current_stage = 'documentation'`, stamps `merged_at` and `github_pr_number`, fires the documentation stage in the background.

All other events are acked `200` and ignored. Duplicate deliveries lose the race on `claimForDocumentation` and are no-ops.

## Auth and CORS

The bearer middleware (`src/middleware/auth.ts`) runs in the `onRequest` hook. There is no CORS handling — the server is consumed by `tsx` CLIs and webhooks; no browsers are clients.
