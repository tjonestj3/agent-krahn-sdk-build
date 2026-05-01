import { runRouter, runWorkIdentifier } from './agents/runner.js';
import type { AgentResult } from './agents/types.js';
import {
  type TriagePayload,
  hasBlocker as triageHasBlocker,
} from './agents/triage-agent.js';
import type { RouterPayload } from './agents/router-agent.js';
import {
  type WorkIdentifierPayload,
  hasBlocker as workIdentifierHasBlocker,
} from './agents/work-identifier-agent.js';
import {
  type PipelineRow,
  updatePipeline,
  logEvent,
} from './db/pipelines.js';

export type PausedStage = 'triage' | 'work_identifier';

export type OrchestratorOutcome =
  | {
      status: 'awaiting_input';
      stage: PausedStage;
      pipeline: PipelineRow;
      triage: TriagePayload;
      routed?: RouterPayload;
      work_identifier?: WorkIdentifierPayload;
      blockers: { question: string; blocker: boolean }[];
    }
  | {
      status: 'completed';
      pipeline: PipelineRow;
      triage: TriagePayload;
      routed: RouterPayload;
      work_identifier: WorkIdentifierPayload;
    };

/**
 * Entry point after Triage has run (initial submit, or resume of a triage pause).
 * Caller is responsible for persisting the Triage payload + session_id and
 * logging the triage stage_completed event BEFORE calling this.
 *
 * Flow: triage blocker gate → Router → Work Identifier blocker gate → done.
 */
export async function processPipelineFromTriage(
  pipeline: PipelineRow,
  triage: AgentResult<TriagePayload>,
): Promise<OrchestratorOutcome> {
  if (triageHasBlocker(triage.data)) {
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

    return {
      status: 'awaiting_input',
      stage: 'triage',
      pipeline: paused,
      triage: triage.data,
      blockers,
    };
  }

  return runRouterStage(pipeline, triage.data);
}

async function runRouterStage(
  pipeline: PipelineRow,
  triage: TriagePayload,
): Promise<OrchestratorOutcome> {
  await updatePipeline(pipeline.id, { current_stage: 'router' });
  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_started',
    stage: 'router',
  });

  const routed = await runRouter(pipeline.raw_request, triage);

  const updated = await updatePipeline(pipeline.id, {
    client_id: routed.data.client,
    dev_hub_alias: routed.data.recommended_dev_hub,
    org_type: 'scratch',
    session_id: routed.sessionId,
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_completed',
    stage: 'router',
    payload: routed.data,
  });

  return runWorkIdentifierStage(updated, triage, routed.data);
}

async function runWorkIdentifierStage(
  pipeline: PipelineRow,
  triage: TriagePayload,
  routed: RouterPayload,
): Promise<OrchestratorOutcome> {
  await updatePipeline(pipeline.id, { current_stage: 'work_identifier' });
  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_started',
    stage: 'work_identifier',
  });

  const wi = await runWorkIdentifier(pipeline.raw_request, triage, routed);

  const afterWi = await updatePipeline(pipeline.id, {
    work_identifier_payload: wi.data,
    session_id: wi.sessionId,
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_completed',
    stage: 'work_identifier',
    payload: wi.data,
  });

  return finalizeAfterWorkIdentifier(afterWi, triage, routed, wi.data);
}

/**
 * Entry point after a Work Identifier resume (the human just answered a
 * blocker on the work_identifier stage). Caller is responsible for persisting
 * the new WI payload + session_id and logging stage_completed BEFORE calling.
 */
export async function processPipelineFromWorkIdentifier(
  pipeline: PipelineRow,
  wi: AgentResult<WorkIdentifierPayload>,
): Promise<OrchestratorOutcome> {
  if (!pipeline.triage_payload) {
    throw new Error(
      `pipeline ${pipeline.id} has no triage_payload — cannot resume work_identifier`,
    );
  }
  if (!pipeline.client_id && !pipeline.dev_hub_alias) {
    throw new Error(
      `pipeline ${pipeline.id} has no router output — cannot resume work_identifier`,
    );
  }

  const routed: RouterPayload = {
    client: pipeline.client_id,
    confidence: 'high',
    reasoning: 'restored from pipeline row on resume',
    recommended_dev_hub: pipeline.dev_hub_alias,
    options: [],
  };

  return finalizeAfterWorkIdentifier(pipeline, pipeline.triage_payload, routed, wi.data);
}

async function finalizeAfterWorkIdentifier(
  pipeline: PipelineRow,
  triage: TriagePayload,
  routed: RouterPayload,
  wi: WorkIdentifierPayload,
): Promise<OrchestratorOutcome> {
  if (workIdentifierHasBlocker(wi)) {
    const blockers = wi.ambiguities.filter((a) => a.blocker);

    const paused = await updatePipeline(pipeline.id, {
      status: 'awaiting_input',
      current_stage: 'work_identifier',
    });

    await logEvent({
      pipeline_id: pipeline.id,
      event_type: 'awaiting_input',
      stage: 'work_identifier',
      payload: { blockers },
    });

    return {
      status: 'awaiting_input',
      stage: 'work_identifier',
      pipeline: paused,
      triage,
      routed,
      work_identifier: wi,
      blockers,
    };
  }

  const done = await updatePipeline(pipeline.id, {
    status: 'completed',
    current_stage: null,
  });

  return {
    status: 'completed',
    pipeline: done,
    triage,
    routed,
    work_identifier: wi,
  };
}
