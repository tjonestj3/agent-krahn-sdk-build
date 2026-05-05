import { supabase } from './client.js';
import type { TriagePayload } from '../agents/triage-agent.js';
import type { RouterPayload } from '../agents/router-agent.js';
import type { WorkIdentifierPayload } from '../agents/work-identifier-agent.js';
import type { ExecutionPayload } from '../agents/execution-agent.js';
import type { DocumentationPayload } from '../agents/documentation-agent.js';
import type { AgentResult } from '../agents/types.js';

export type PipelineStatus =
  | 'running'
  | 'awaiting_input'
  | 'awaiting_review'
  | 'completed'
  | 'failed';

export interface PipelineRow {
  id: string;
  source: string;
  raw_request: string;
  client_id: string | null;
  org_type: string | null;
  dev_hub_alias: string | null;
  triage_payload: TriagePayload | null;
  routed_payload: RouterPayload | null;
  work_identifier_payload: WorkIdentifierPayload | null;
  execution_payload: ExecutionPayload | null;
  documentation_payload: DocumentationPayload | null;
  documentation_path: string | null;
  scratch_org_alias: string | null;
  branch_name: string | null;
  pr_url: string | null;
  github_pr_number: number | null;
  merged_at: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  status: PipelineStatus;
  session_id: string | null;
  current_stage: string | null;
  created_at: string;
  updated_at: string;
}

export async function createPipeline(input: {
  source: string;
  raw_request: string;
}): Promise<PipelineRow> {
  const { data, error } = await supabase
    .from('pipelines')
    .insert({
      source: input.source,
      raw_request: input.raw_request,
      status: 'running',
      current_stage: 'triage',
    })
    .select()
    .single();

  if (error) throw new Error(`createPipeline: ${error.message}`);
  return data as PipelineRow;
}

export async function updatePipeline(
  id: string,
  patch: Partial<Omit<PipelineRow, 'id' | 'created_at'>>,
): Promise<PipelineRow> {
  const { data, error } = await supabase
    .from('pipelines')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`updatePipeline: ${error.message}`);
  return data as PipelineRow;
}

export async function getPipeline(id: string): Promise<PipelineRow | null> {
  const { data, error } = await supabase
    .from('pipelines')
    .select()
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`getPipeline: ${error.message}`);
  return (data as PipelineRow | null) ?? null;
}

/**
 * Look up the pipeline whose notifier-DM thread root matches the given
 * Slack thread_ts. Used by the inbound Slack handler to route a thread
 * reply back to the right paused pipeline.
 */
export async function getPipelineBySlackThread(
  threadTs: string,
): Promise<PipelineRow | null> {
  const { data, error } = await supabase
    .from('pipelines')
    .select()
    .eq('slack_message_ts', threadTs)
    .maybeSingle();

  if (error) throw new Error(`getPipelineBySlackThread: ${error.message}`);
  return (data as PipelineRow | null) ?? null;
}

/**
 * Look up the pipeline whose merged PR matches a GitHub webhook delivery.
 * Tries pr_url first (set by the Execution agent), then github_pr_number
 * (which the webhook handler may set on first contact). Returns null if
 * the PR is unknown — webhook should ack 200 and move on.
 */
export async function getPipelineByPr(args: {
  prUrl?: string | null;
  prNumber?: number | null;
}): Promise<PipelineRow | null> {
  if (args.prUrl) {
    const { data, error } = await supabase
      .from('pipelines')
      .select()
      .eq('pr_url', args.prUrl)
      .maybeSingle();
    if (error) throw new Error(`getPipelineByPr(url): ${error.message}`);
    if (data) return data as PipelineRow;
  }
  if (args.prNumber != null) {
    const { data, error } = await supabase
      .from('pipelines')
      .select()
      .eq('github_pr_number', args.prNumber)
      .maybeSingle();
    if (error) throw new Error(`getPipelineByPr(num): ${error.message}`);
    if (data) return data as PipelineRow;
  }
  return null;
}

/**
 * Atomically flip a pipeline from awaiting_review → running with stage set
 * to documentation. Returns the row on success, or null if the pipeline
 * was no longer in awaiting_review (idempotent against duplicate webhooks).
 */
export async function claimForDocumentation(
  id: string,
): Promise<PipelineRow | null> {
  const { data, error } = await supabase
    .from('pipelines')
    .update({
      status: 'running',
      current_stage: 'documentation',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'awaiting_review')
    .select()
    .maybeSingle();

  if (error) throw new Error(`claimForDocumentation: ${error.message}`);
  return (data as PipelineRow | null) ?? null;
}

/**
 * Atomically flip a pipeline from awaiting_input → running. Returns the row
 * on success, or null if the pipeline was no longer in awaiting_input
 * (e.g. another /respond call already claimed it).
 */
export async function claimForRunning(id: string): Promise<PipelineRow | null> {
  const { data, error } = await supabase
    .from('pipelines')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'awaiting_input')
    .select()
    .maybeSingle();

  if (error) throw new Error(`claimForRunning: ${error.message}`);
  return (data as PipelineRow | null) ?? null;
}

export async function logEvent(input: {
  pipeline_id: string;
  event_type: string;
  stage?: string;
  payload?: unknown;
}): Promise<void> {
  const { error } = await supabase.from('pipeline_events').insert({
    pipeline_id: input.pipeline_id,
    event_type: input.event_type,
    stage: input.stage ?? null,
    payload: input.payload ?? null,
  });

  if (error) throw new Error(`logEvent: ${error.message}`);
}

/**
 * Log a `stage_telemetry` event capturing token + cost + turn metrics from
 * an agent run. Best-effort: a logging failure must not crash the
 * pipeline. Telemetry rows accumulate alongside stage_completed events
 * so cli/pipelines.ts can sum them when inspecting a run.
 */
export async function logStageTelemetry<T>(args: {
  pipeline_id: string;
  stage: string;
  agent: string;
  model: string;
  result: AgentResult<T>;
}): Promise<void> {
  await logEvent({
    pipeline_id: args.pipeline_id,
    event_type: 'stage_telemetry',
    stage: args.stage,
    payload: {
      agent: args.agent,
      model: args.model,
      ...args.result.telemetry,
    },
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[telemetry] logStageTelemetry failed for ${args.pipeline_id}`, err);
  });
}

export interface PipelineEventRow {
  event_type: string;
  stage: string | null;
  payload: unknown;
  created_at: string;
}

export async function recentEvents(
  pipelineId: string,
  limit = 50,
): Promise<PipelineEventRow[]> {
  const { data, error } = await supabase
    .from('pipeline_events')
    .select('event_type, stage, payload, created_at')
    .eq('pipeline_id', pipelineId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`recentEvents: ${error.message}`);
  return (data ?? []) as PipelineEventRow[];
}
