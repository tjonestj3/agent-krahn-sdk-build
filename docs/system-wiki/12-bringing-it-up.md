---
title: Bringing it up
slug: bring-up
group: Operations
order: 3
---

# Bringing it up

First-time setup, in order.

## 1. Install dependencies

```bash
npm install
```

Make sure `sf`, `gh`, and `git` are on your `PATH`. Authenticate them:

```bash
sf org login web
gh auth login
```

## 2. Create the Supabase tables

Open the Supabase SQL editor for your project and run, in order:

```
db/migrations/001_add_triage_payload.sql
db/migrations/002_add_work_identifier_payload.sql
db/migrations/003_add_execution_columns.sql
db/migrations/004_add_slack_columns.sql
db/migrations/005_add_documentation_columns.sql
```

(If your project is fresh and there are no `pipelines` / `pipeline_events` base tables, create them first — they are documented in the original Phase 0 plan.)

## 3. Configure `.env`

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — your Anthropic console key.
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — from the Supabase project dashboard.
- `KRAHNBORN_API_TOKEN` — any random ≥ 32 chars; generate with `openssl rand -hex 32`.
- `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` — from your Slack app's basic info / OAuth pages.
- `GITHUB_WEBHOOK_SECRET` — any random ≥ 16 chars.

## 4. Set up the Slack app

In api.slack.com:

- **OAuth scopes:** `chat:write`, `im:write`, `users:read`, `users:read.email`.
- **Event subscriptions:** point at your public-facing `https://<host>/slack/events`. Subscribe to `message.im`.
- Install to workspace.

For local dev, expose your localhost via `cloudflared tunnel`, `ngrok`, or similar. The pipeline does not require the public endpoint while running locally — only the inbound Slack reply path does.

## 5. Set up the GitHub webhook

On the repo (or repos) the pipeline will open PRs against:

- **Settings → Webhooks → Add webhook.**
- Payload URL: `https://<host>/github/webhook`.
- Content type: `application/json`.
- Secret: same value as `GITHUB_WEBHOOK_SECRET`.
- Events: just **Pull requests**.

Until the webhook is wired the pipeline still reaches `awaiting_review` cleanly — it just never advances past it on merge.

## 6. Seed the vault

For each client you want the pipeline to operate on, create `~/vault/clients/<name>/_index.md` with the org alias, repo remote+local, and a starter role permset registry. See [Environment](#) for the format.

## 7. Sanity-check

```bash
npm run typecheck   # should pass silently
npm run dev         # should boot listening on :3000
curl -s localhost:3000/health   # → {"status":"ok"}
```

Run a representative request through Triage in isolation:

```bash
npm run triage -- "Add a Picklist Account_Tier__c on Lead with values Bronze/Silver/Gold"
```

The output should be a structured JSON — no errors, no auth issues.

## 8. Run the full pipeline

```bash
npm run dev    # in one terminal
npm run request -- "Your real request text here"   # in another
```

The CLI polls until terminal. Watch the Slack DMs in parallel to see pauses and the PR notification.

## 9. After a merged PR

Manually verify the build record landed:

```bash
ls ~/vault/clients/<client>/changes/
```

Then build the per-client wiki:

```bash
npm run wiki -- <client>
open wiki/<client>.html
```
