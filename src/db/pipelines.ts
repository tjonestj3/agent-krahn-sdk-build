import { supabase } from './client.js';
import type { TriagePayload } from '../agents/triage-agent.js';

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
