-- Persist the full Router agent payload alongside the other stage payloads.
-- Previously the orchestrator synthesised a RouterPayload on every resume
-- using just `client_id` + `dev_hub_alias` from the row, hard-coding
-- `confidence: 'high'` and a placeholder `reasoning`. The Work Identifier,
-- Execution, and Documentation agents all consume the full routed payload
-- in their user prompts, and the Documentation system prompt templates
-- `routed.confidence` into the build record — so the synthesised values
-- corrupted downstream output for any router run that wasn't actually
-- high-confidence. Store the real payload, read it back on resume.

alter table pipelines
  add column if not exists routed_payload jsonb;
