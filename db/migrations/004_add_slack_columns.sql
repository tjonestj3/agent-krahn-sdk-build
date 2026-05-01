-- Track the Slack DM that notified the human of a pipeline state change,
-- so an inbound thread reply can be routed back to the right pipeline.

alter table pipelines
  add column if not exists slack_channel_id text,
  add column if not exists slack_message_ts text;

create index if not exists idx_pipelines_slack_message_ts
  on pipelines (slack_message_ts)
  where slack_message_ts is not null;
