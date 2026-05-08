---
title: The Slack loop
slug: slack-loop
group: How it works
order: 2
---

# The Slack loop

The pipeline is async by design. A submitted request returns immediately with `status: 'running'`, and the human's only required interaction is via Slack DMs.

## What the human sees

1. **Submit a request** — three equivalent ways:
   - `npm run request -- "..."` (CLI).
   - `POST /requests` directly (HTTP, bearer auth).
   - **`/krahn` slash command in Slack** → opens a modal (Client / Urgency / Change type / Title / Description) → submit POSTs to `/requests` with `source: 'slack-console'`. Served by the **Krahn Console** Slack app, a separate process from the Notifier — see [Architecture](#architecture) for the split.
2. **A Slack DM arrives** when the pipeline pauses or terminates:
   - `🟡 Pipeline ... paused at <stage>` with the question, plus (for execution-stage pauses) a link to open the scratch org in the browser.
   - `✅ Pipeline ... opened a PR` with the PR link, branch name, and scratch alias.
   - `🎉 Pipeline ... complete` with the merged PR link and the build record path.
   - `❌ Pipeline ... failed at <stage>` with the error message.
3. **Reply in the thread** to answer a paused pipeline. The bot does not ack — the next state-change DM in the same thread is the implicit acknowledgement.

All DMs for a given pipeline land in a single thread, so the conversation about that pipeline stays tidy.

## Under the hood

- The notifier looks up the recipient by email (default `thomas@krahnborn.com`, override with `SLACK_USER_EMAIL`) and falls back to a name search (`SLACK_USER_NAME_FALLBACK`).
- The first DM's channel + ts are persisted on the pipeline row (`slack_channel_id`, `slack_message_ts`). Subsequent DMs reply in that thread.
- `POST /slack/events` verifies the Slack HMAC signature, then for thread-reply messages it looks up the pipeline by `slack_message_ts` and resumes via the same `claimAndResume()` path that `POST /requests/:id/respond` uses.
- Top-level (non-thread) DMs get a friendly reply explaining the convention. They are not currently a way to submit new requests.

## What you cannot do via Slack (yet)

- Submit a request from a free-form Slack message. (Possible via the Krahn Console `/krahn` modal; a chat-style submission isn't.)
- Cancel a running pipeline from Slack. (Cancel button on the Notifier DM is in flight.)
- Ask the bot for status. The Krahn Console **App Home** tab renders an inflight-pipelines dashboard — it reads Supabase directly, not through `/requests`. For terminal queries: `npm run pipelines` or `GET /requests/<id>`.

These omissions exist because cross-user authorization, identity, and rate-limiting were Phase-1 deferrals. The Krahn Console closes the submission gap for allowlisted users (`SLACK_ALLOWED_USERS`) without changing the trust model.
