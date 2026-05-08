import type { FastifyPluginAsync } from 'fastify';
import { cancelPipeline } from '../services/cancel.js';

interface PipelineParams {
  id: string;
}

export const pipelinesRoute: FastifyPluginAsync = async (app) => {
  app.post('/pipelines/:id/cancel', async (req, reply) => {
    const { id } = req.params as PipelineParams;
    const outcome = await cancelPipeline(id, 'http');

    if (outcome.ok) {
      return reply.send({ pipeline: outcome.pipeline });
    }
    if (outcome.reason === 'not_found') {
      return reply.code(404).send({ error: 'pipeline not found' });
    }
    return reply
      .code(409)
      .send({ error: 'pipeline already terminal', status: outcome.status });
  });
};
