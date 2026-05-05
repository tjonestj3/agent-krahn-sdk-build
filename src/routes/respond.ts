import type { FastifyPluginAsync } from 'fastify';
import { claimAndResume } from '../services/resume.js';

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

    const outcome = await claimAndResume(id, answer);

    if (outcome.ok) {
      return reply.code(202).send({
        pipeline_id: id,
        status: outcome.pipeline.status,
        current_stage: outcome.pipeline.current_stage,
        pipeline: outcome.pipeline,
      });
    }

    switch (outcome.reason) {
      case 'not_found':
        return reply.code(404).send({ error: 'pipeline not found' });
      case 'not_paused':
        return reply.code(409).send({
          error: `pipeline is not awaiting input (${outcome.detail ?? 'unknown'})`,
        });
      case 'no_session':
        return reply.code(500).send({ error: 'pipeline has no session_id to resume' });
      case 'unsupported_stage':
        return reply.code(501).send({
          error: `cannot yet resume stage: ${outcome.detail ?? 'null'}`,
        });
    }
  });
};
