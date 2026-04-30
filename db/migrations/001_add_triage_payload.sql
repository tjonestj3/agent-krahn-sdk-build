-- Phase 1: Triage agent — adds a column to hold the structured Triage output.
-- The raw_request stays canonical; triage_payload is enrichment that downstream
-- agents (Router, Work Identifier, Execution) can rely on without re-parsing.

alter table pipelines
  add column if not exists triage_payload jsonb;
