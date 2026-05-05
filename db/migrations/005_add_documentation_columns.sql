-- Documentation stage and GitHub webhook plumbing.
-- After a PR is merged on GitHub, the orchestrator transitions the pipeline
-- from awaiting_review → running (current_stage='documentation'), runs the
-- Documentation agent, persists its payload here, and ends at completed.

alter table pipelines
  add column if not exists github_pr_number integer,
  add column if not exists documentation_payload jsonb,
  add column if not exists documentation_path text,
  add column if not exists merged_at timestamptz;

create index if not exists idx_pipelines_github_pr_number
  on pipelines (github_pr_number)
  where github_pr_number is not null;

create index if not exists idx_pipelines_pr_url
  on pipelines (pr_url)
  where pr_url is not null;
