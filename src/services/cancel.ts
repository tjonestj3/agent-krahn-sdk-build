import { getPipeline, logEvent, updatePipeline, type PipelineRow } from '../db/pipelines.js';

export type CancelOutcome =
  | { ok: true; pipeline: PipelineRow }
  | { ok: false; reason: 'not_found' | 'terminal'; status?: string };

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Idempotent cancel: flips a non-terminal pipeline to status `cancelled` and
 * logs the event. If the pipeline is already terminal (completed / failed /
 * cancelled), does nothing and reports the current status. Always returns
 * cleanly — callers should display the outcome to the user.
 *
 * Note: this does NOT abort an in-flight agent run. Phase 0/1 pipelines are
 * event-driven — `running` only exists for the few seconds an agent's
 * `query()` is open. The realistic targets for cancel are `awaiting_input`
 * and `awaiting_review`, which is where pipelines actually sit idle.
 */
export async function cancelPipeline(
  pipelineId: string,
  source: string,
): Promise<CancelOutcome> {
  const existing = await getPipeline(pipelineId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (TERMINAL.has(existing.status)) {
    return { ok: false, reason: 'terminal', status: existing.status };
  }

  const updated = await updatePipeline(pipelineId, {
    status: 'cancelled',
    current_stage: null,
  });

  await logEvent({
    pipeline_id: pipelineId,
    event_type: 'pipeline_cancelled',
    stage: existing.current_stage ?? 'unknown',
    payload: { source, prior_status: existing.status, prior_stage: existing.current_stage },
  }).catch(() => {});

  return { ok: true, pipeline: updated };
}
