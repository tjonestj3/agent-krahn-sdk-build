-- Phase 1: Work Identifier agent — adds a column to hold the structured Work
-- Identifier output. Triage gives a coarse change_type; the Router picks a Dev
-- Hub; the Work Identifier refines the change classification, sizes the
-- effort, and pins down target metadata so the Execution agent can act
-- without re-reasoning about scope.

alter table pipelines
  add column if not exists work_identifier_payload jsonb;
