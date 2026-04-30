import { runRouter } from './agents/runner.js';
import type { AgentResult } from './agents/types.js';
import { type TriagePayload, hasBlocker } from './agents/triage-agent.js';
import type { RouterPayload } from './agents/router-agent.js';
import {
  type PipelineRow,
  updatePipeline,
  logEvent,
} from './db/pipelines.js';

export type OrchestratorOutcome =
  | {
      status: 'awaiting_input';
      pipeline: PipelineRow;
      triage: TriagePayload;
      blockers: TriagePayload['ambiguities'];
    }
  | {
      status: 'completed';
      pipeline: PipelineRow;
      triage: TriagePayload;
      routed: RouterPayload;
    };

/**
 * Shared post-Triage logic. Used by both the initial POST /requests and the
 * resume path POST /requests/:id/respond.
 *
 * Caller is responsible for:
 *   - Persisting the Triage payload + session_id BEFORE calling this.
 *   - Logging the 'stage_completed' event for triage BEFORE calling this.
 *
 * This function then handles: blocker gate → Router invocation → final state.
 */
export async function processPipelineFromTriage(
  pipeline: PipelineRow,
  triage: AgentResult<TriagePayload>,
): Promise<OrchestratorOutcome> {
  if (hasBlocker(triage.data)) {
    const blockers = triage.data.ambiguities.filter((a) => a.blocker);

    const paused = await updatePipeline(pipeline.id, {
      status: 'awaiting_input',
      current_stage: 'triage',
    });

    await logEvent({
      pipeline_id: pipeline.id,
      event_type: 'awaiting_input',
      stage: 'triage',
      payload: { blockers },
    });

    return { status: 'awaiting_input', pipeline: paused, triage: triage.data, blockers };
  }

  await updatePipeline(pipeline.id, { current_stage: 'router' });
  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_started',
    stage: 'router',
  });

  const routed = await runRouter(pipeline.raw_request, triage.data);

  const updated = await updatePipeline(pipeline.id, {
    client_id: routed.data.client,
    dev_hub_alias: routed.data.recommended_dev_hub,
    org_type: 'scratch',
    session_id: routed.sessionId,
    status: 'completed',
    current_stage: null,
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_completed',
    stage: 'router',
    payload: routed.data,
  });

  return { status: 'completed', pipeline: updated, triage: triage.data, routed: routed.data };
}
