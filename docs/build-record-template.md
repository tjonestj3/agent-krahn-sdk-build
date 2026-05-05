# Build record template

This is the canonical shape of every file the Documentation agent writes into `~/vault/clients/<client>/changes/`. The wiki generator (`scripts/build-wiki.ts`) consumes these files. Keep the structure stable so:

1. Future agent runs can reference past builds (the doc agent reads them too).
2. The wiki always renders the same way — no surprise sections.
3. A consultant deliverable looks like a consultant deliverable, not a transcript.

## File path

`~/vault/clients/<client>/changes/<YYYY-MM-DD>-<slug>.md`

`<slug>` is the lowercased work_classification with `[^a-z0-9]+` collapsed to `-` and trimmed to ≤ 60 chars. Example: `2026-05-04-add-custom-picklist-field-account-tier-on-lead.md`.

## Frontmatter (required)

```yaml
---
type: build_record
date: 2026-05-04
client: krahnborn
pipeline_id: <uuid>
pr_number: 42
pr_url: https://github.com/.../pull/42
classification: Add custom Picklist field Account_Tier__c on Lead
story_points: 2
---
```

Every key is required. `pr_number` and `pr_url` may be `null` if (somehow) absent. `story_points` is the integer Fibonacci value the Work Identifier emitted.

## Body sections (order matters)

The wiki generator reads section headers verbatim. **Do not rename, reorder, or remove sections** without updating the renderer.

```markdown
# <classification>

## Summary

<One short paragraph: what got built, who it's for, the user-visible behavior change.>

## Original request

> <verbatim raw_request, may be multi-line, blockquoted>

## What changed

### Schema

<Bulleted list, one entry per metadata_changes item. Use a clear human label. e.g. "**Lead.Account_Tier__c** — new Picklist field with values Bronze / Silver / Gold (default Bronze)." If empty: "No schema changes.">

### Access

<Bulleted list, one entry per permission_grants. Format: "**<permset name>** (extended | new) — <plain-English grant description>". If empty: "No permission changes.">

### Code & flows

<Anything Apex / Flow / LWC / validation rule. Skip this h3 entirely if nothing applies — DO NOT write "N/A".>

## How to verify

<Numbered list, ≤ 8 items. Pulled from the PR body's "How to verify" section, or from execution_payload.verification_steps.>

## Rollback

<One paragraph + concrete commands. Pulled from PR body's "Rollback notes", or inferred from the diff.>

## Build trail

| Stage | Result |
|---|---|
| Triage | <triage.summary> · change_type: `<change_type>` · urgency: `<urgency>` |
| Router | client: `<client>` · dev hub: `<recommended_dev_hub>` (`<confidence>` confidence) |
| Work Identifier | <story_points> pts · permission_strategy: `<permission_strategy>` |
| Execution | branch `<branch_name>` → <pr_url> |
| Merged | <merged_at> |

## Decisions worth remembering

<3–6 bullets capturing anything a future agent run should know about this client/area. If routine: a single bullet "Routine build, no decisions worth flagging.".>
```

## Why these sections, in this order

- **Summary** answers "what is this?" in one paragraph — the only thing a busy reader is guaranteed to read.
- **Original request** preserves the verbatim ask. Useful for misclassification post-mortems and for training future Triage iterations.
- **What changed** is split into **Schema / Access / Code** because consultants and admins look at different layers when reviewing a build. Keeping access in its own subsection also makes audit trails clean (e.g., "show me everything we granted Sales_User_Account_Fields in the last quarter").
- **How to verify** + **Rollback** are the operational sections. Together they make this a runbook, not just a record.
- **Build trail** is the five-row summary that lets a reader trace the work back through the pipeline if anything looks off.
- **Decisions worth remembering** is the layer that makes the doc useful to *agents* on subsequent runs. The doc agent reads these on future builds for the same client to avoid re-asking resolved questions.

## What the wiki does with it

`npm run wiki -- <client>` produces a single self-contained HTML file in `wiki/<client>.html`. Open it directly — no server. The layout: sidebar list of all build records (sorted newest-first), main pane renders the selected record. Frontmatter drives the sidebar metadata (date / classification / story points). Body sections render as you'd expect.
