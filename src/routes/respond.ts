import type { FastifyPluginAsync } from 'fastify';
import { resumeTriage, resumeWorkIdentifier } from '../agents/runner.js';
import {
  getPipeline,
  claimForRunning,
  updatePipeline,
  logEvent,
} from '../db/pipelines.js';
import {
  processPipelineFromTriage,
  processPipelineFromWorkIdentifier,
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
    if (stage !== 'triage' && stage !== 'work_identifier') {
      return reply.code(501).send({
        error: `cannot yet resume stage: ${stage ?? 'null'}`,
      });
    }

    // Optimistic claim: flips awaiting_input → running atomically. If another
    // /respond beat us to it, the claim returns null and we 409.
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

    try {
      await logEvent({ pipeline_id: id, event_type: 'stage_resumed', stage });

      if (stage === 'triage') {
        const triage = await resumeTriage(claimed.session_id!, answer);

        const triagedRow = await updatePipeline(id, {
          triage_payload: triage.data,
          session_id: triage.sessionId,
        });

        await logEvent({
          pipeline_id: id,
          event_type: 'stage_completed',
          stage: 'triage',
          payload: triage.data,
        });

        const outcome = await processPipelineFromTriage(triagedRow, triage);
        return reply.send(outcome);
      }

      // stage === 'work_identifier'
      const wi = await resumeWorkIdentifier(claimed.session_id!, answer);

      const wiRow = await updatePipeline(id, {
        work_identifier_payload: wi.data,
        session_id: wi.sessionId,
      });

      await logEvent({
        pipeline_id: id,
        event_type: 'stage_completed',
        stage: 'work_identifier',
        payload: wi.data,
      });

      const outcome = await processPipelineFromWorkIdentifier(wiRow, wi);
      return reply.send(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updatePipeline(id, { status: 'failed' }).catch(() => {});
      await logEvent({
        pipeline_id: id,
        event_type: 'stage_failed',
        stage,
        payload: { error: message, while: 'resume' },
      }).catch(() => {});
      return reply.code(500).send({ error: message, pipeline_id: id });
    }
  });
};
