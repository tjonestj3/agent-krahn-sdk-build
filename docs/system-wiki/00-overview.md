---
title: Overview
slug: overview
group: Start here
order: 1
---

# Krahnborn OS

A backend pipeline that turns a plain-English Salesforce request into a merged GitHub PR and a documented build record — without a human writing any metadata XML by hand.

## What it does, end to end

1. A request lands ("add a Picklist `Account_Tier__c` on Lead with values Bronze/Silver/Gold").
2. A Triage agent parses it into a structured payload.
3. A Router agent picks the client and the Dev Hub.
4. A Work Identifier agent classifies the work, sizes it, and writes a precise spec the Execution agent can act on without re-thinking scope.
5. The orchestrator preps a feature branch and a fresh scratch org.
6. An Execution agent edits metadata, deploys to the scratch org, runs Apex tests, commits, and opens a GitHub PR.
7. A Slack DM tells the human a PR is up.
8. Human reviews and merges. GitHub fires a webhook.
9. A Documentation agent writes a build record into `~/vault/clients/<client>/changes/`.
10. The pipeline reaches `completed`.

If anything is ambiguous at any stage, the pipeline pauses, DMs the human, and resumes when they reply in the Slack thread.

## Why it exists

This is built as a **first-line triage** for everyday Salesforce work. Cheap, easy requests that don't need senior judgment go through the pipeline; the human (Thomas) keeps focus on the harder, more architectural asks. The pipeline is also a way to send pre-architected requests through automation rather than working alongside an agent on each one.

## Five guarantees

These hard rules are enforced in code, not just in prompts:

1. **No profile edits, ever.** Access changes always go through permission sets. The orchestrator runs a post-PR diff guard that closes any PR touching profile XML.
2. **Dev Hub-only Router.** The Router only ever recommends orgs with `isDevHub: true`. Real work always runs in a scratch org spun from a Dev Hub.
3. **One pipeline at a time per client repo.** An in-process mutex serializes active execution runs per client so two pipelines never fight over the working tree or `.sf/config.json`.
4. **Per-client role permset registry.** `vault/clients/<name>/_index.md` is the canonical list. Work Identifier extends one before proposing a new permset, and `create_new` always pauses for human confirmation.
5. **Verifiable cost.** Every agent run logs token, turn, and cost telemetry to `pipeline_events`. Surfaces in `npm run pipelines -- <id>`.

## Where this fits in your stack

- **Vault** at `~/vault/` — the *why* layer. Decisions, client quirks, runbooks.
- **Per-project `CLAUDE.md`** files — code-level invariants only.
- **`sf` CLI** — all Salesforce work; the pipeline shells out, no Salesforce MCPs.
- **Krahnborn OS** (this) — the agent pipeline that sits between human intent and committed Salesforce metadata.
