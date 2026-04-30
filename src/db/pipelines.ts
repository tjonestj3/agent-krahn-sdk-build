import { supabase } from './client.js';

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
      current_stage: 'router',
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
