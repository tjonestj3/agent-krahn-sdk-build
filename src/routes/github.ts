import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import {
  claimForDocumentation,
  getPipelineByPr,
  updatePipeline,
  logEvent,
} from '../db/pipelines.js';
import { processPipelineFromMerge } from '../orchestrator.js';
import { verifyGithubRequest } from '../github/verify.js';

interface GithubPullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    html_url: string;
    merged: boolean;
    merged_at: string | null;
    title: string;
    state: 'open' | 'closed';
  };
  repository?: { full_name?: string };
}

type GithubPayload = GithubPullRequestEvent | { action?: string; [k: string]: unknown };

type GithubRequest = FastifyRequest & { rawBody?: string };

export const githubRoute: FastifyPluginAsync = async (app) => {
  // Reuse the raw-body capture pattern from /slack/events so HMAC over the
  // exact bytes works. Local to this plugin scope.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        (req as GithubRequest).rawBody = typeof body === 'string' ? body : body.toString('utf8');
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/github/webhook', async (req, reply) => {
    const rawBody = (req as GithubRequest).rawBody;
    if (!rawBody) {
      return reply.code(400).send({ error: 'empty body' });
    }

    const sig = req.headers['x-hub-signature-256'];
    if (typeof sig !== 'string') {
      return reply.code(401).send({ error: 'missing signature' });
    }
    if (!verifyGithubRequest(rawBody, sig, env.GITHUB_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const eventName = req.headers['x-github-event'];
    if (eventName !== 'pull_request') {
      // Ack everything else; we just don't act on it.
      return reply.code(200).send({ ok: true, ignored: 'event' });
    }

    const payload = req.body as GithubPayload;
    if (!isPullRequestEvent(payload)) {
      return reply.code(200).send({ ok: true, ignored: 'shape' });
    }

    if (payload.action !== 'closed') {
      return reply.code(200).send({ ok: true, ignored: 'action' });
    }
    if (!payload.pull_request.merged) {
      // Closed-without-merge — log and move on. The pipeline will eventually
      // need a different signal to clean up (Phase 4); for now do nothing.
      app.log.info(
        { pr: payload.pull_request.html_url },
        'pull_request closed without merge — ignoring',
      );
      return reply.code(200).send({ ok: true, ignored: 'not_merged' });
    }

    const pr = payload.pull_request;
    const pipeline = await getPipelineByPr({
      prUrl: pr.html_url,
      prNumber: pr.number,
    }).catch((err) => {
      app.log.warn({ err, pr: pr.html_url }, 'getPipelineByPr failed');
      return null;
    });

    if (!pipeline) {
      // PR isn't ours — that's normal (e.g. a doc PR opened by hand).
      return reply.code(200).send({ ok: true, ignored: 'unknown_pr' });
    }

    if (pipeline.status !== 'awaiting_review') {
      app.log.info(
        { pipeline_id: pipeline.id, status: pipeline.status },
        'merge event for pipeline not awaiting_review — ignoring (likely duplicate)',
      );
      return reply.code(200).send({ ok: true, ignored: 'wrong_status' });
    }

    const claimed = await claimForDocumentation(pipeline.id);
    if (!claimed) {
      // Lost the race to a duplicate webhook delivery.
      return reply.code(200).send({ ok: true, ignored: 'race' });
    }

    const stamped = await updatePipeline(claimed.id, {
      merged_at: pr.merged_at ?? new Date().toISOString(),
      github_pr_number: pr.number,
    });

    await logEvent({
      pipeline_id: stamped.id,
      event_type: 'pr_merged',
      stage: 'documentation',
      payload: {
        pr_url: pr.html_url,
        pr_number: pr.number,
        merged_at: stamped.merged_at,
      },
    });

    // Acknowledge fast, run the doc agent in the background.
    void processPipelineFromMerge(stamped).catch((err) => {
      app.log.error(
        { err, pipeline_id: stamped.id },
        'processPipelineFromMerge failed',
      );
    });

    return reply.code(202).send({
      ok: true,
      pipeline_id: stamped.id,
      stage: 'documentation',
    });
  });
};

function isPullRequestEvent(p: GithubPayload): p is GithubPullRequestEvent {
  return (
    typeof p === 'object' &&
    p != null &&
    'pull_request' in p &&
    typeof (p as { pull_request: unknown }).pull_request === 'object'
  );
}
