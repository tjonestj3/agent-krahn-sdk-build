# Canned-prompts test harness

Smoke-tests the Triage + Work Identifier prompts against a fixed set of representative requests so prompt regressions show up as snapshot diffs rather than as production surprises.

## Run

```bash
# Run all cases. Diffs against existing snapshots; exits 1 on any drift.
npm run test:prompts

# Run a single case by name.
npm run test:prompts -- field-add-simple

# Accept the current outputs as the new snapshots (e.g. after a prompt change).
npm run test:prompts -- --update
```

Snapshots live in `snapshots/<case-name>.json`. Commit them so prompt changes show up in code review.

## What this does NOT do

- It skips the Router agent (which would shell out to `sf org list`). A synthetic Router payload is fed to the Work Identifier instead.
- It does not run the Execution agent or the Documentation agent. Both of those have side effects (writes, deploys, PRs, vault writes).
- It does not hit Supabase. No DB writes.

## Adding a case

Edit `cases.json`:

```json
{
  "name": "your-case-slug",
  "request": "the raw request text..."
}
```

Then `npm run test:prompts -- your-case-slug` to generate the first snapshot.

## When a snapshot diverges

A diff doesn't necessarily mean the prompt is broken — it might mean it's better. The workflow is:

1. Run `npm run test:prompts`.
2. Look at the cases that diverged.
3. For each: is the new output better or worse?
4. If better: `npm run test:prompts -- --update` to accept.
5. If worse: investigate the prompt regression before committing.
