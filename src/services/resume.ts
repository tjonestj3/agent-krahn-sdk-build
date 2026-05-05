import {
  resumeTriage,
  resumeWorkIdentifier,
  resumeExecution,
} from '../agents/runner.js';
import { TRIAGE_CONFIG } from '../agents/triage-agent.js';
import { WORK_IDENTIFIER_CONFIG } from '../agents/work-identifier-agent.js';
import { EXECUTION_CONFIG } from '../agents/execution-agent.js';
import {
  getPipeline,
  claimForRunning,
  updatePipeline,
  logEvent,
  logStageTelemetry,
  type PipelineRow,
} from '../db/pipelines.js';
import {
  processPipelineFromTriage,
  processPipelineFromWorkIdentifier,
  processPipelineFromExecution,
  rehydrateExecutionContext,
} from '../orchestrator.js';
import { withClientRepoLock } from '../execution/repo-lock.js';
import { notifyFailed } from '../slack/notifier.js';

export type ResumableStage = 'triage' | 'work_identifier' | 'execution';

export type ResumeOutcome =
  | { ok: true; pipeline: PipelineRow; stage: ResumableStage }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'not_paused'
        | 'no_session'
        | 'unsupported_stage';
      detail?: string;
    };

/**
 * Single entry point for resuming a paused pipeline. Loads + validates the
 * pipeline, atomically claims it (awaiting_input → running), logs the
 * human_response event, and fires the actual resume work in the background.
 *
 * Both POST /requests/:id/respond and the Slack /slack/events handler call
 * this. They differ in how they surface failures (HTTP status codes vs. a
 * threaded Slack reply), but the work is the same.
 */
export async function claimAndResume(
  pipelineId: string,
  answer: string,
): Promise<ResumeOutcome> {
  const existing = await getPipeline(pipelineId);
  if (!existing) return { ok: false, reason: 'not_found' };

  if (existing.status !== 'awaiting_input') {
    return { ok: false, reason: 'not_paused', detail: existing.status };
  }
  if (!existing.session_id) {
    return { ok: false, reason: 'no_session' };
  }

  const stage = existing.current_stage;
  if (stage !== 'triage' && stage !== 'work_identifier' && stage !== 'execution') {
    return { ok: false, reason: 'unsupported_stage', detail: stage ?? 'null' };
  }

  const claimed = await claimForRunning(pipelineId);
  if (!claimed) {
    return { ok: false, reason: 'not_paused', detail: 'lost-race' };
  }

  await logEvent({
    pipeline_id: pipelineId,
    event_type: 'human_response',
    stage,
    payload: { answer },
  });

  fireAndForget(`resume-${pipelineId}`, () => runResume(claimed, stage, answer));

  return { ok: true, pipeline: claimed, stage };
}

function fireAndForget(label: string, work: () => Promise<void>): void {
  void work().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[fireAndForget:${label}]`, err);
  });
}

async function runResume(
  claimed: PipelineRow,
  stage: ResumableStage,
  answer: string,
): Promise<void> {
  try {
    await logEvent({ pipeline_id: claimed.id, event_type: 'stage_resumed', stage });

    if (stage === 'triage') {
      const triage = await resumeTriage(claimed.session_id!, answer);
      const triagedRow = await updatePipeline(claimed.id, {
        triage_payload: triage.data,
        session_id: triage.sessionId,
      });
      await logEvent({
        pipeline_id: claimed.id,
        event_type: 'stage_completed',
        stage: 'triage',
        payload: triage.data,
      });
      await logStageTelemetry({
        pipeline_id: claimed.id,
        stage: 'triage',
        agent: TRIAGE_CONFIG.name,
        model: TRIAGE_CONFIG.model,
        result: triage,
      });
      await processPipelineFromTriage(triagedRow, triage);
      return;
    }

    if (stage === 'work_identifier') {
      const wi = await resumeWorkIdentifier(claimed.session_id!, answer);
      const wiRow = await updatePipeline(claimed.id, {
        work_identifier_payload: wi.data,
        session_id: wi.sessionId,
      });
      await logEvent({
        pipeline_id: claimed.id,
        event_type: 'stage_completed',
        stage: 'work_identifier',
        payload: wi.data,
      });
      await logStageTelemetry({
        pipeline_id: claimed.id,
        stage: 'work_identifier',
        agent: WORK_IDENTIFIER_CONFIG.name,
        model: WORK_IDENTIFIER_CONFIG.model,
        result: wi,
      });
      await processPipelineFromWorkIdentifier(wiRow, wi);
      return;
    }

    // stage === 'execution'
    if (!claimed.client_id) {
      throw new Error(`pipeline ${claimed.id} has no client_id; cannot lock repo`);
    }
    await withClientRepoLock(claimed.client_id, async () => {
      const ctx = await rehydrateExecutionContext(claimed);
      const exec = await resumeExecution(claimed.session_id!, answer, ctx);
      const execRow = await updatePipeline(claimed.id, {
        execution_payload: exec.data,
        session_id: exec.sessionId,
        pr_url: exec.data.pr_url ?? claimed.pr_url ?? null,
      });
      await logEvent({
        pipeline_id: claimed.id,
        event_type: 'stage_completed',
        stage: 'execution',
        payload: exec.data,
      });
      await logStageTelemetry({
        pipeline_id: claimed.id,
        stage: 'execution',
        agent: EXECUTION_CONFIG.name,
        model: EXECUTION_CONFIG.model,
        result: exec,
      });
      await processPipelineFromExecution(execRow, exec);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await updatePipeline(claimed.id, { status: 'failed' }).catch(() => null);
    await logEvent({
      pipeline_id: claimed.id,
      event_type: 'stage_failed',
      stage,
      payload: { error: message, while: 'resume' },
    }).catch(() => {});
    if (failed) await notifyFailed(failed, message, stage);
  }
}
