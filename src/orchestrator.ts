import { runRouter, runWorkIdentifier, runExecution } from './agents/runner.js';
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
import type { ExecutionPayload } from './agents/execution-agent.js';
import {
  type ExecutionContext,
  setupExecutionEnvironment,
} from './execution/setup.js';
import { loadClientConfig } from './config/clients.js';
import {
  type PipelineRow,
  updatePipeline,
  logEvent,
} from './db/pipelines.js';

export type PausedStage = 'triage' | 'work_identifier' | 'execution';

export type OrchestratorOutcome =
  | {
      status: 'awaiting_input';
      stage: PausedStage;
      pipeline: PipelineRow;
      triage: TriagePayload;
      routed?: RouterPayload;
      work_identifier?: WorkIdentifierPayload;
      execution?: ExecutionPayload;
      blockers: { question: string; blocker: boolean }[];
    }
  | {
      status: 'awaiting_review';
      pipeline: PipelineRow;
      triage: TriagePayload;
      routed: RouterPayload;
      work_identifier: WorkIdentifierPayload;
      execution: ExecutionPayload;
    };

/**
 * Entry point after Triage has run (initial submit, or resume of a triage pause).
 * Caller persists Triage payload + session_id and logs the triage stage_completed
 * event BEFORE calling. This function then drives blocker gates and downstream
 * stages.
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

  return continueAfterWorkIdentifier(afterWi, triage, routed, wi.data);
}

/**
 * Entry point after a Work Identifier resume (human answered a WI blocker).
 * Caller has persisted the new WI payload + session_id and logged
 * stage_completed BEFORE calling.
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

  return continueAfterWorkIdentifier(pipeline, pipeline.triage_payload, routed, wi.data);
}

async function continueAfterWorkIdentifier(
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

  return runExecutionStage(pipeline, triage, routed, wi);
}

async function runExecutionStage(
  pipeline: PipelineRow,
  triage: TriagePayload,
  routed: RouterPayload,
  wi: WorkIdentifierPayload,
): Promise<OrchestratorOutcome> {
  await updatePipeline(pipeline.id, { current_stage: 'execution' });
  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_started',
    stage: 'execution',
  });

  // Pre-agent setup: branch, scratch org, source push, target-org config.
  // If this throws, mark the pipeline failed at this stage.
  const ctx = await setupExecutionEnvironment(pipeline, wi);

  const afterSetup = await updatePipeline(pipeline.id, {
    scratch_org_alias: ctx.scratch_org_alias,
    branch_name: ctx.branch_name,
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'execution_setup_done',
    stage: 'execution',
    payload: {
      scratch_org_alias: ctx.scratch_org_alias,
      branch_name: ctx.branch_name,
      scratch_org_id: ctx.scratch_org_id,
    },
  });

  const exec = await runExecution(
    pipeline.raw_request,
    triage,
    routed,
    wi,
    ctx,
  );

  const afterExec = await updatePipeline(pipeline.id, {
    execution_payload: exec.data,
    session_id: exec.sessionId,
    pr_url: exec.data.pr_url ?? null,
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_completed',
    stage: 'execution',
    payload: exec.data,
  });

  return finalizeAfterExecution(afterExec, triage, routed, wi, exec.data);
}

/**
 * Entry point after an Execution resume (human answered an execution blocker).
 * Caller has persisted the new execution payload + session_id and logged
 * stage_completed BEFORE calling.
 */
export async function processPipelineFromExecution(
  pipeline: PipelineRow,
  exec: AgentResult<ExecutionPayload>,
): Promise<OrchestratorOutcome> {
  if (!pipeline.triage_payload || !pipeline.work_identifier_payload) {
    throw new Error(
      `pipeline ${pipeline.id} missing prior payloads — cannot resume execution`,
    );
  }
  if (!pipeline.client_id || !pipeline.dev_hub_alias) {
    throw new Error(
      `pipeline ${pipeline.id} missing router output — cannot resume execution`,
    );
  }

  const routed: RouterPayload = {
    client: pipeline.client_id,
    confidence: 'high',
    reasoning: 'restored from pipeline row on resume',
    recommended_dev_hub: pipeline.dev_hub_alias,
    options: [],
  };

  return finalizeAfterExecution(
    pipeline,
    pipeline.triage_payload,
    routed,
    pipeline.work_identifier_payload,
    exec.data,
  );
}

async function finalizeAfterExecution(
  pipeline: PipelineRow,
  triage: TriagePayload,
  routed: RouterPayload,
  wi: WorkIdentifierPayload,
  exec: ExecutionPayload,
): Promise<OrchestratorOutcome> {
  if (exec.status === 'needs_input') {
    const blockers = (exec.ambiguities ?? []).filter((a) => a.blocker);

    const paused = await updatePipeline(pipeline.id, {
      status: 'awaiting_input',
      current_stage: 'execution',
    });

    await logEvent({
      pipeline_id: pipeline.id,
      event_type: 'awaiting_input',
      stage: 'execution',
      payload: {
        blocked_on: exec.blocked_on,
        attempts: exec.attempts,
        blockers,
      },
    });

    return {
      status: 'awaiting_input',
      stage: 'execution',
      pipeline: paused,
      triage,
      routed,
      work_identifier: wi,
      execution: exec,
      blockers,
    };
  }

  // status === 'pr_opened'
  const done = await updatePipeline(pipeline.id, {
    status: 'awaiting_review',
    current_stage: null,
    pr_url: exec.pr_url ?? null,
  });

  return {
    status: 'awaiting_review',
    pipeline: done,
    triage,
    routed,
    work_identifier: wi,
    execution: exec,
  };
}

/**
 * Reconstruct the ExecutionContext from a persisted pipeline row, for the
 * execution-resume path. The branch and scratch org already exist from the
 * initial run; we just need to feed the agent the same context object it
 * had when it paused.
 */
export async function rehydrateExecutionContext(
  pipeline: PipelineRow,
): Promise<ExecutionContext> {
  if (
    !pipeline.client_id ||
    !pipeline.scratch_org_alias ||
    !pipeline.branch_name ||
    !pipeline.dev_hub_alias
  ) {
    throw new Error(
      `pipeline ${pipeline.id} missing execution context fields; cannot resume`,
    );
  }
  const client = await loadClientConfig(pipeline.client_id);
  if (!client.repo_local) {
    throw new Error(
      `vault/clients/${pipeline.client_id}/_index.md is missing "Local:" repo path`,
    );
  }
  return {
    client: pipeline.client_id,
    repo_local: client.repo_local,
    branch_name: pipeline.branch_name,
    scratch_org_alias: pipeline.scratch_org_alias,
    scratch_org_id: null,
    scratch_login_url: null,
    dev_hub_alias: pipeline.dev_hub_alias,
  };
}
