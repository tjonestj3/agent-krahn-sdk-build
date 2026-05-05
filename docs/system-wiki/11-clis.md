---
title: CLIs
slug: clis
group: Operations
order: 2
---

# CLIs

All under `npm run`. Each maps to a `tsx` script in `src/cli/` or `scripts/`.

## Pipeline CLIs

```bash
# Submit a request to the running server. Polls until terminal.
npm run request -- "Add a Picklist Account_Tier__c on Lead..."

# Answer a paused pipeline.
npm run respond -- <pipeline_id> "use the Sales_User_Account_Fields permset"

# List recent pipelines, or filter by status.
npm run pipelines
npm run pipelines -- awaiting_input
npm run pipelines -- failed

# Inspect one pipeline (full row + last 100 events + telemetry summary).
npm run pipelines -- <pipeline_id>
```

The server must be running (`npm run dev`) for `request`/`respond`. `pipelines` queries Supabase directly and works whether the server is up or not.

## Agent-in-isolation CLIs

For prompt iteration without a DB or HTTP layer:

```bash
# Just Triage.
npm run triage -- "raw request text"
npm run triage -- --file path/to/request.txt

# Just Router (in-process; no DB).
npm run router -- "raw request"

# Triage → Router → Work Identifier in-process. End-to-end taste with no side effects.
npm run work-identifier -- "raw request"
```

These are the fastest way to see if a prompt change actually moved the needle on a representative request. They do not write to Supabase and do not run the Execution or Documentation agents.

## Test harness

```bash
# Run all canned cases against current prompts; diff against snapshots.
npm run test:prompts

# Run one case.
npm run test:prompts -- field-add-simple

# Update snapshots after an intentional prompt change.
npm run test:prompts -- --update
```

Cases live in `test/prompts/cases.json`; snapshots in `test/prompts/snapshots/`. Commit both.

## Wikis

```bash
# Per-client build wiki — renders ~/vault/clients/<client>/changes/*.md.
npm run wiki -- krahnborn

# This system wiki (the page you are reading).
npm run wiki:system
```

Output: `wiki/<client>.html` and `wiki/system.html`. Self-contained — open with your file manager.

## Server lifecycle

```bash
# Dev (hot, but the agent SDK doesn't actually reload state on file change).
npm run dev:watch

# Dev (no watch).
npm run dev

# Compile to dist/.
npm run build

# Run compiled.
npm start

# Typecheck without compiling.
npm run typecheck
```

## Notable absences

There is no `npm run` for: cancelling a pipeline, deleting a scratch org, replaying a webhook delivery, exporting telemetry to CSV. These are all things to add as the system gets more use.
