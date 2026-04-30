import type { FastifyPluginAsync } from 'fastify';
import { runRouter } from '../agents/runner.js';
import { createPipeline, updatePipeline, logEvent } from '../db/pipelines.js';

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
    await logEvent({
      pipeline_id: pipeline.id,
      event_type: 'created',
      payload: { source },
    });

    try {
      await logEvent({
        pipeline_id: pipeline.id,
        event_type: 'stage_started',
        stage: 'router',
      });

      const routed = await runRouter(raw_request);

      const updated = await updatePipeline(pipeline.id, {
        client_id: routed.client,
        dev_hub_alias: routed.recommended_dev_hub,
        org_type: 'scratch',
        session_id: routed.session_id,
        status: 'completed',
        current_stage: null,
      });

      await logEvent({
        pipeline_id: pipeline.id,
        event_type: 'stage_completed',
        stage: 'router',
        payload: routed,
      });

      return reply.send({ pipeline: updated, routed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updatePipeline(pipeline.id, { status: 'failed' }).catch(() => {});
      await logEvent({
        pipeline_id: pipeline.id,
        event_type: 'stage_failed',
        stage: 'router',
        payload: { error: message },
      }).catch(() => {});
      return reply.code(500).send({ error: message, pipeline_id: pipeline.id });
    }
  });
};
