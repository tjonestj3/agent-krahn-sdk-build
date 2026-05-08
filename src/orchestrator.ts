import {
  runRouter,
  runWorkIdentifier,
  runExecution,
  runDocumentation,
} from './agents/runner.js';
import { resolveClientMcpServers } from './mcp/registry.js';
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
import type {
  DocumentationPayload,
  DocumentationContext,
} from './agents/documentation-agent.js';
import {
  type ExecutionContext,
  setupExecutionEnvironment,
} from './execution/setup.js';
import {
  inspectExecutionDiff,
  closePrWithReason,
  resetFeatureBranch,
  type DiffViolation,
} from './execution/guard.js';
import { withClientRepoLock } from './execution/repo-lock.js';
import { loadClientConfig } from './config/clients.js';
import { env } from './config/env.js';
import {
  type PipelineRow,
  updatePipeline,
  logEvent,
  logStageTelemetry,
} from './db/pipelines.js';
import { ROUTER_CONFIG } from './agents/router-agent.js';
import { WORK_IDENTIFIER_CONFIG } from './agents/work-identifier-agent.js';
import { EXECUTION_CONFIG } from './agents/execution-agent.js';
import { DOCUMENTATION_CONFIG } from './agents/documentation-agent.js';
import {
  notifyAwaitingInput,
  notifyAwaitingReview,
  notifyCompleted,
  notifyFailed,
} from './slack/notifier.js';

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
    }
  | {
      status: 'completed';
      pipeline: PipelineRow;
      triage: TriagePayload;
      routed: RouterPayload;
      work_identifier: WorkIdentifierPayload;
      execution: ExecutionPayload;
      documentation: DocumentationPayload;
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

    await notifyAwaitingInput(paused, 'triage', blockers);

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
    routed_payload: routed.data,
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_completed',
    stage: 'router',
    payload: routed.data,
  });
  await logStageTelemetry({
    pipeline_id: pipeline.id,
    stage: 'router',
    agent: ROUTER_CONFIG.name,
    model: ROUTER_CONFIG.model,
    result: routed,
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
  await logStageTelemetry({
    pipeline_id: pipeline.id,
    stage: 'work_identifier',
    agent: WORK_IDENTIFIER_CONFIG.name,
    model: WORK_IDENTIFIER_CONFIG.model,
    result: wi,
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
  if (!pipeline.routed_payload) {
    throw new Error(
      `pipeline ${pipeline.id} has no routed_payload — cannot resume work_identifier`,
    );
  }

  return continueAfterWorkIdentifier(
    pipeline,
    pipeline.triage_payload,
    pipeline.routed_payload,
    wi.data,
  );
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

    await notifyAwaitingInput(paused, 'work_identifier', blockers);

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
  if (!pipeline.client_id) {
    throw new Error(`pipeline ${pipeline.id} has no client_id; cannot lock repo`);
  }

  await updatePipeline(pipeline.id, { current_stage: 'execution' });
  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_started',
    stage: 'execution',
  });

  // Serialize active execution runs per client repo so two pipelines never
  // fight over the working tree, the branch, or .sf/config.json. A pipeline
  // that pauses to awaiting_input releases the lock; resume re-acquires.
  return withClientRepoLock(pipeline.client_id, async () => {
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

    const mcpServers = await resolveClientMcpServers(routed.client);
    const exec = await runExecution(
      pipeline.raw_request,
      triage,
      routed,
      wi,
      ctx,
      mcpServers,
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
    await logStageTelemetry({
      pipeline_id: pipeline.id,
      stage: 'execution',
      agent: EXECUTION_CONFIG.name,
      model: EXECUTION_CONFIG.model,
      result: exec,
    });

    return finalizeAfterExecution(afterExec, triage, routed, wi, exec.data);
  });
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
  if (!pipeline.routed_payload) {
    throw new Error(
      `pipeline ${pipeline.id} missing routed_payload — cannot resume execution`,
    );
  }

  return finalizeAfterExecution(
    pipeline,
    pipeline.triage_payload,
    pipeline.routed_payload,
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

    await notifyAwaitingInput(
      paused,
      'execution',
      blockers,
      exec.blocked_on ? { blocked_on: exec.blocked_on } : undefined,
    );

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
  // Hard-rule guard: refuse to leave the pipeline in awaiting_review if the
  // diff includes anything the orchestrator forbids (profile metadata,
  // for now). Close the PR, pause the pipeline, and ask the human whether
  // to retry — the execution agent will be resumed with the violation as
  // its prompt.
  const guard = await runDiffGuard(pipeline, exec);
  if (guard) return guard;

  const done = await updatePipeline(pipeline.id, {
    status: 'awaiting_review',
    current_stage: null,
    pr_url: exec.pr_url ?? null,
  });

  await notifyAwaitingReview(done);

  return {
    status: 'awaiting_review',
    pipeline: done,
    triage,
    routed,
    work_identifier: wi,
    execution: exec,
  };
}

async function runDiffGuard(
  pipeline: PipelineRow,
  exec: ExecutionPayload,
): Promise<OrchestratorOutcome | null> {
  if (!pipeline.client_id || !pipeline.branch_name) return null;

  const client = await loadClientConfig(pipeline.client_id);
  if (!client.repo_local) return null;

  const guard = await inspectExecutionDiff(
    client.repo_local,
    pipeline.branch_name,
  ).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[diff-guard] inspect failed:', err);
    return null;
  });
  if (!guard || guard.ok) return null;

  const reason = formatViolationMessage(guard.violations);

  if (exec.pr_url) {
    await closePrWithReason(client.repo_local, exec.pr_url, reason);
  }
  if (pipeline.branch_name) {
    await resetFeatureBranch(client.repo_local, pipeline.branch_name);
  }

  const blockers = [
    {
      question:
        'The PR was closed because it violated a hard rule (see "blocked_on"). Reply with how to redo this without the forbidden change — e.g. "use the Sales_User_Account_Fields permission set" — and the agent will retry.',
      blocker: true,
    },
  ];

  const paused = await updatePipeline(pipeline.id, {
    status: 'awaiting_input',
    current_stage: 'execution',
    pr_url: null,
    execution_payload: {
      ...exec,
      status: 'needs_input',
      pr_url: null,
      blocked_on: reason,
      ambiguities: blockers,
    },
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'diff_guard_violation',
    stage: 'execution',
    payload: { violations: guard.violations, changed_files: guard.changedFiles },
  });

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'awaiting_input',
    stage: 'execution',
    payload: { blocked_on: reason, blockers },
  });

  await notifyAwaitingInput(paused, 'execution', blockers, { blocked_on: reason });

  if (
    !paused.triage_payload ||
    !paused.work_identifier_payload ||
    !paused.routed_payload
  ) {
    throw new Error(`pipeline ${pipeline.id} missing payloads after diff guard`);
  }

  return {
    status: 'awaiting_input',
    stage: 'execution',
    pipeline: paused,
    triage: paused.triage_payload,
    routed: paused.routed_payload,
    work_identifier: paused.work_identifier_payload,
    execution: { ...exec, status: 'needs_input', pr_url: null, blocked_on: reason },
    blockers,
  };
}

function formatViolationMessage(violations: DiffViolation[]): string {
  const profilePaths = violations
    .filter((v) => v.rule === 'profile_metadata')
    .map((v) => v.path);
  if (profilePaths.length === 0) {
    return 'PR rejected by orchestrator diff guard.';
  }
  return [
    'PR rejected: this pipeline forbids edits to Profile metadata.',
    'Files that violated the rule:',
    ...profilePaths.map((p) => `- ${p}`),
    '',
    'Use a permission set for any access changes instead. Reply with the',
    'permission set to extend (or "create new" + the role it serves) and',
    'the agent will redo the work without touching profiles.',
  ].join('\n');
}

/**
 * Entry point fired by the GitHub webhook when a pipeline's PR is merged.
 * Caller has already claimed awaiting_review → running and stamped
 * merged_at + github_pr_number. We run the Documentation agent and
 * transition to completed.
 */
export async function processPipelineFromMerge(
  pipeline: PipelineRow,
): Promise<OrchestratorOutcome> {
  if (
    !pipeline.client_id ||
    !pipeline.triage_payload ||
    !pipeline.routed_payload ||
    !pipeline.work_identifier_payload ||
    !pipeline.execution_payload
  ) {
    throw new Error(
      `pipeline ${pipeline.id} missing prior payloads; cannot run documentation`,
    );
  }

  const client = await loadClientConfig(pipeline.client_id);
  if (!client.repo_local) {
    throw new Error(
      `vault/clients/${pipeline.client_id}/_index.md is missing "Local:" repo path`,
    );
  }

  const routed = pipeline.routed_payload;

  const mergedAt = pipeline.merged_at ?? new Date().toISOString();
  const dateOnly = mergedAt.slice(0, 10);
  const slug = slugify(pipeline.work_identifier_payload.work_classification).slice(0, 60);
  const filename = `${dateOnly}-${slug}.md`;
  const vaultPath = `${env.VAULT_PATH}/clients/${pipeline.client_id}/changes`;

  const ctx: DocumentationContext = {
    pipeline_id: pipeline.id,
    client: pipeline.client_id,
    vault_path: vaultPath,
    vault_filename: filename,
    repo_local: client.repo_local,
    branch_name: pipeline.branch_name,
    pr_url: pipeline.pr_url,
    pr_number: pipeline.github_pr_number,
    scratch_org_alias: pipeline.scratch_org_alias,
    merged_at: mergedAt,
  };

  await logEvent({
    pipeline_id: pipeline.id,
    event_type: 'stage_started',
    stage: 'documentation',
  });

  try {
    const doc = await runDocumentation(
      pipeline,
      pipeline.triage_payload,
      routed,
      pipeline.work_identifier_payload,
      pipeline.execution_payload,
      ctx,
    );

    const completed = await updatePipeline(pipeline.id, {
      status: 'completed',
      current_stage: null,
      documentation_payload: doc.data,
      documentation_path: doc.data.vault_path,
      session_id: doc.sessionId,
    });

    await logEvent({
      pipeline_id: pipeline.id,
      event_type: 'stage_completed',
      stage: 'documentation',
      payload: doc.data,
    });
    await logStageTelemetry({
      pipeline_id: pipeline.id,
      stage: 'documentation',
      agent: DOCUMENTATION_CONFIG.name,
      model: DOCUMENTATION_CONFIG.model,
      result: doc,
    });

    await notifyCompleted(completed);

    return {
      status: 'completed',
      pipeline: completed,
      triage: pipeline.triage_payload,
      routed,
      work_identifier: pipeline.work_identifier_payload,
      execution: pipeline.execution_payload,
      documentation: doc.data,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await updatePipeline(pipeline.id, { status: 'failed' }).catch(() => null);
    await logEvent({
      pipeline_id: pipeline.id,
      event_type: 'stage_failed',
      stage: 'documentation',
      payload: { error: message },
    }).catch(() => {});
    if (failed) await notifyFailed(failed, message, 'documentation');
    throw err;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
