---
title: Walkthrough — adding a custom field
slug: walkthrough
group: How it works
order: 3
---

# Walkthrough — adding a custom field

A concrete trace of what the system does for the request:

> Add a Picklist field `Account_Tier__c` on Lead with values Bronze, Silver, Gold. Default to Bronze. Tonya needs to be able to edit it.

## 1. Submission

You run `npm run request -- "..."`. The CLI POSTs `/requests`. The handler:

- Inserts a row in `pipelines` with `status = 'running'`, `current_stage = 'triage'`.
- Logs a `created` event.
- Fires the pipeline in the background and returns `202` with the new `pipeline_id`.

## 2. Triage

Haiku parses the text, returns:

```json
{
  "summary": "Add Picklist field Account_Tier__c on Lead with values Bronze/Silver/Gold (default Bronze)",
  "change_type": "add_field",
  "salesforce_objects": ["Lead"],
  "urgency": "this_week",
  "client_hints": ["tonya"],
  "ambiguities": []
}
```

No blockers. Pipeline continues.

## 3. Router

Sonnet 4.6 reads the local org list (`bin/sf-orgs-summary.sh`) and the client `_index.md` files. Identifies the client as `krahnborn` and the Dev Hub as `krahn`. Stores both on the pipeline row.

## 4. Work Identifier

Sonnet 4.6 reads the Triage output, the Router output, and the krahnborn role permset registry. Returns:

```json
{
  "work_classification": "Add custom Picklist field Account_Tier__c on Lead",
  "metadata_changes": [
    { "object": "Lead", "field": "Account_Tier__c", "field_type": "Picklist",
      "operation": "create", "notes": "Values: Bronze, Silver, Gold. Default Bronze. Required: false." }
  ],
  "permission_strategy": "extend_existing",
  "permission_grants": [
    { "permission_set": "Sales_User_Account_Fields", "strategy": "extend_existing",
      "rationale": "Tonya is a sales user; the registered sales role permset applies",
      "fields": [{ "object": "Lead", "field": "Account_Tier__c", "access": "edit" }],
      "objects": [] }
  ],
  "story_points": 2,
  "ambiguities": []
}
```

No blockers. Pipeline continues.

## 5. Execution setup (orchestrator-side, no agent)

The orchestrator:

1. Acquires the per-client repo lock (in-memory mutex).
2. Loads the client config; finds `~/Salesforce/KRAHN/Krahn-Agent-Project/`.
3. Asserts the working tree is clean.
4. `git fetch origin && git checkout main && git pull --ff-only`.
5. Creates branch `krahnborn-os/<short-id>-add-custom-picklist-field-account-tier-on-lead` and checks it out.
6. Spins a scratch org (`bin/spin-scratch.sh krahn krahnborn-os-<short-id> 7`).
7. `sf project deploy start --target-org <scratch-alias>` — pushes current `main` into the scratch.
8. `sf config set target-org=<scratch-alias>` — local default for the agent.

Returns an `ExecutionContext`. Logs `execution_setup_done`.

## 6. Execution agent

`cwd = repo root`. Sonnet 4.6 with full file + Bash tools. The agent:

1. Reads the WI spec.
2. Writes `force-app/main/default/objects/Lead/fields/Account_Tier__c.field-meta.xml` (the new field).
3. Edits `force-app/main/default/permissionsets/Sales_User_Account_Fields.permissionset-meta.xml` to add a `<fieldPermissions>` block.
4. `sf project deploy start -d force-app/main/default/objects/Lead/fields/Account_Tier__c.field-meta.xml -d force-app/main/default/permissionsets/Sales_User_Account_Fields.permissionset-meta.xml`. Deploy succeeds (or the agent retries up to 3 times).
5. `sf apex run test --result-format human --code-coverage --wait 10` (or notes "no relevant tests").
6. `git add <paths>`, `git commit`, `git push -u origin <branch>`.
7. `gh pr create --base main --title "..." --body "..."` with the four required sections (What changed / How to verify / Expected behavior / Rollback notes).
8. Emits `{ "status": "pr_opened", "pr_url": "...", "branch_name": "...", "files_changed": [...], "tests_run": [...], "verification_steps": [...] }`.

## 7. Diff guard

The orchestrator runs `git diff --name-only origin/main...<branch>`. None of the changed paths are profile metadata. Guard passes.

## 8. Pause for review

Pipeline transitions to `awaiting_review`. The notifier DMs the human with the PR link and scratch alias. Lock released.

## 9. Human reviews and merges

Human opens the PR, looks at the diff, opens the scratch org via the linked alias to verify the field renders, merges the PR.

## 10. GitHub webhook fires

GitHub POSTs `pull_request.closed` (with `merged: true`) to `/github/webhook`. The handler:

- Verifies the HMAC signature.
- Looks up the pipeline by `pr_url` or `pr_number`.
- Atomically claims `awaiting_review → running` with `current_stage = 'documentation'`.
- Stamps `merged_at` and `github_pr_number`.
- Logs `pr_merged`.
- Fires the documentation stage in the background; returns `202`.

## 11. Documentation agent

`cwd = client repo`. Sonnet 4.6. The agent runs `gh pr view <num> --json files,additions,deletions,body,title,mergedAt,author` and writes a build record at:

```
~/vault/clients/krahnborn/changes/2026-05-04-add-custom-picklist-field-account-tier-on-lead.md
```

Following the [build record template](#) — frontmatter + summary + schema/access sections + verification + rollback + build trail + decisions. Emits `{ "status": "documented", "vault_path": "...", "summary": "..." }`.

## 12. Completion

Pipeline transitions to `completed`. The notifier DMs `🎉 Pipeline ... complete` with the merged PR link and the build record path. Telemetry is logged for every stage along the way; `npm run pipelines -- <id>` shows the totals.
