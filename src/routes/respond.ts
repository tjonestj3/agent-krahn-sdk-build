import type { FastifyPluginAsync } from 'fastify';
import {
  resumeTriage,
  resumeWorkIdentifier,
  resumeExecution,
} from '../agents/runner.js';
import {
  getPipeline,
  claimForRunning,
  updatePipeline,
  logEvent,
  type PipelineRow,
} from '../db/pipelines.js';
import {
  processPipelineFromTriage,
  processPipelineFromWorkIdentifier,
  processPipelineFromExecution,
  rehydrateExecutionContext,
} from '../orchestrator.js';

interface RespondBody {
  answer?: string;
}

interface RespondParams {
  id: string;
}

export const respondRoute: FastifyPluginAsync = async (app) => {
  app.post('/requests/:id/respond', async (req, reply) => {
    const { id } = req.params as RespondParams;
    const body = (req.body ?? {}) as RespondBody;
    const answer = body.answer;

    if (!answer || typeof answer !== 'string') {
      return reply.code(400).send({ error: 'answer (string) is required' });
    }

    const existing = await getPipeline(id);
    if (!existing) return reply.code(404).send({ error: 'pipeline not found' });

    if (existing.status !== 'awaiting_input') {
      return reply.code(409).send({
        error: `pipeline is not awaiting input (status=${existing.status})`,
      });
    }

    if (!existing.session_id) {
      return reply.code(500).send({ error: 'pipeline has no session_id to resume' });
    }

    const stage = existing.current_stage;
    if (stage !== 'triage' && stage !== 'work_identifier' && stage !== 'execution') {
      return reply.code(501).send({
        error: `cannot yet resume stage: ${stage ?? 'null'}`,
      });
    }

    // Atomic flip from awaiting_input → running. Loses the race if another
    // /respond beat us to it.
    const claimed = await claimForRunning(id);
    if (!claimed) {
      return reply.code(409).send({
        error: 'pipeline was not in awaiting_input state (concurrent respond?)',
      });
    }

    await logEvent({
      pipeline_id: id,
      event_type: 'human_response',
      stage,
      payload: { answer },
    });

    fireAndForget(`resume-${id}`, () => runResume(claimed, stage, answer));

    return reply.code(202).send({
      pipeline_id: id,
      status: claimed.status,
      current_stage: claimed.current_stage,
      pipeline: claimed,
    });
  });
};

function fireAndForget(label: string, work: () => Promise<void>): void {
  void work().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[fireAndForget:${label}]`, err);
  });
}

async function runResume(
  claimed: PipelineRow,
  stage: 'triage' | 'work_identifier' | 'execution',
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
      await processPipelineFromWorkIdentifier(wiRow, wi);
      return;
    }

    // stage === 'execution'
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
    await processPipelineFromExecution(execRow, exec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updatePipeline(claimed.id, { status: 'failed' }).catch(() => {});
    await logEvent({
      pipeline_id: claimed.id,
      event_type: 'stage_failed',
      stage,
      payload: { error: message, while: 'resume' },
    }).catch(() => {});
  }
}
