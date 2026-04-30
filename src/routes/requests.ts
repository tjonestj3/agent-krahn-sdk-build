import type { FastifyPluginAsync } from 'fastify';
import { runTriage } from '../agents/runner.js';
import { createPipeline, updatePipeline, logEvent } from '../db/pipelines.js';
import { processPipelineFromTriage } from '../orchestrator.js';

interface CreateRequestBody {
  source?: string;
  raw_request?: string;
}

export const requestsRoute: FastifyPluginAsync = async (app) => {
  app.post('/requests', async (req, reply) => {
    const body = (req.body ?? {}) as CreateRequestBody;
    const source = body.source ?? 'manual';
    const raw_request = body.raw_request;

    if (!raw_request || typeof raw_request !== 'string') {
      return reply.code(400).send({ error: 'raw_request (string) is required' });
    }

    const pipeline = await createPipeline({ source, raw_request });
    await logEvent({ pipeline_id: pipeline.id, event_type: 'created', payload: { source } });

    try {
      // ─── Stage 1: Triage ────────────────────────────────────────────
      await logEvent({ pipeline_id: pipeline.id, event_type: 'stage_started', stage: 'triage' });

      const triage = await runTriage(raw_request);

      const triagedRow = await updatePipeline(pipeline.id, {
        triage_payload: triage.data,
        session_id: triage.sessionId,
      });

      await logEvent({
        pipeline_id: pipeline.id,
        event_type: 'stage_completed',
        stage: 'triage',
        payload: triage.data,
      });

      // ─── Stage 2: blocker gate → Router (or pause) ──────────────────
      const outcome = await processPipelineFromTriage(triagedRow, triage);
      return reply.send(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updatePipeline(pipeline.id, { status: 'failed' }).catch(() => {});
      await logEvent({
        pipeline_id: pipeline.id,
        event_type: 'stage_failed',
        stage: pipeline.current_stage ?? 'unknown',
        payload: { error: message },
      }).catch(() => {});
      return reply.code(500).send({ error: message, pipeline_id: pipeline.id });
    }
  });
};
