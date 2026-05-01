-- Phase 1 M3: Execution agent — adds columns to track the per-pipeline
-- working state created in/by the Execution stage:
--   - scratch_org_alias: the throwaway scratch org spun from the Dev Hub
--   - branch_name: the feature branch created off main for this pipeline's work
--   - execution_payload: the structured Execution-agent output (changes made,
--     tests run, PR url, verification steps)
--   - pr_url: convenience pointer; surfaced into the awaiting_review state

alter table pipelines
  add column if not exists scratch_org_alias text,
  add column if not exists branch_name text,
  add column if not exists execution_payload jsonb,
  add column if not exists pr_url text;
