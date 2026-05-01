import type { FastifyPluginAsync } from 'fastify';
import { runTriage } from '../agents/runner.js';
import {
  createPipeline,
  getPipeline,
  updatePipeline,
  logEvent,
  recentEvents,
  type PipelineRow,
} from '../db/pipelines.js';
import { processPipelineFromTriage } from '../orchestrator.js';
import { notifyFailed } from '../slack/notifier.js';

interface CreateRequestBody {
  source?: string;
  raw_request?: string;
}

interface PipelineParams {
  id: string;
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

    fireAndForget(`pipeline-${pipeline.id}`, () => runFromTriage(pipeline));

    return reply.code(202).send({
      pipeline_id: pipeline.id,
      status: pipeline.status,
      current_stage: pipeline.current_stage,
      pipeline,
    });
  });

  app.get('/requests/:id', async (req, reply) => {
    const { id } = req.params as PipelineParams;
    const pipeline = await getPipeline(id);
    if (!pipeline) return reply.code(404).send({ error: 'pipeline not found' });

    const events = await recentEvents(id);
    return reply.send({ pipeline, events });
  });
};

/**
 * Fire-and-forget wrapper. The inner work() is expected to swallow its own
 * errors and log to pipeline_events. This catch is a safety net for genuinely
 * unexpected bugs; it just prevents an unhandled rejection from crashing the
 * process.
 */
function fireAndForget(label: string, work: () => Promise<void>): void {
  void work().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[fireAndForget:${label}]`, err);
  });
}

async function runFromTriage(pipeline: PipelineRow): Promise<void> {
  try {
    await logEvent({ pipeline_id: pipeline.id, event_type: 'stage_started', stage: 'triage' });

    const triage = await runTriage(pipeline.raw_request);

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

    await processPipelineFromTriage(triagedRow, triage);
  } catch (err) {
    await markFailed(pipeline.id, pipeline.current_stage, err);
  }
}

async function markFailed(
  pipelineId: string,
  stage: string | null | undefined,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const failed = await updatePipeline(pipelineId, { status: 'failed' }).catch(() => null);
  await logEvent({
    pipeline_id: pipelineId,
    event_type: 'stage_failed',
    stage: stage ?? 'unknown',
    payload: { error: message },
  }).catch(() => {});
  if (failed) await notifyFailed(failed, message, stage);
}

