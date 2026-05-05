import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { getPipelineBySlackThread } from '../db/pipelines.js';
import { claimAndResume } from '../services/resume.js';
import { slackClient } from '../slack/client.js';
import { verifySlackRequest } from '../slack/verify.js';

interface SlackUrlVerification {
  type: 'url_verification';
  token: string;
  challenge: string;
}

interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

interface SlackEventCallback {
  type: 'event_callback';
  team_id: string;
  api_app_id: string;
  event: SlackMessageEvent | { type: string; [k: string]: unknown };
  event_id: string;
  event_time: number;
}

type SlackPayload = SlackUrlVerification | SlackEventCallback | { type: string };

type SlackRequest = FastifyRequest & { rawBody?: string };

export const slackRoute: FastifyPluginAsync = async (app) => {
  // Override JSON parser inside this plugin scope so we keep the raw body
  // string for HMAC verification. Outside this scope, the default parser
  // still applies.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        (req as SlackRequest).rawBody = typeof body === 'string' ? body : body.toString('utf8');
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/slack/events', async (req, reply) => {
    const rawBody = (req as SlackRequest).rawBody;
    if (!rawBody) {
      return reply.code(400).send({ error: 'empty body' });
    }

    const sig = req.headers['x-slack-signature'];
    const ts = req.headers['x-slack-request-timestamp'];
    if (typeof sig !== 'string' || typeof ts !== 'string') {
      return reply.code(401).send({ error: 'missing slack signature headers' });
    }

    if (!verifySlackRequest(rawBody, ts, sig, env.SLACK_SIGNING_SECRET)) {
      return reply.code(401).send({ error: 'invalid slack signature' });
    }

    const payload = req.body as SlackPayload;

    if (payload.type === 'url_verification') {
      return reply.send({ challenge: (payload as SlackUrlVerification).challenge });
    }

    if (payload.type === 'event_callback') {
      const cb = payload as SlackEventCallback;
      // Acknowledge fast (Slack expects 200 within 3s); process async.
      void handleSlackEvent(cb, app.log);
      return reply.code(200).send();
    }

    return reply.code(200).send();
  });
};

async function handleSlackEvent(
  payload: SlackEventCallback,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> {
  const ev = payload.event;

  if (ev.type === 'message') {
    const m = ev as SlackMessageEvent;
    if (m.bot_id) return;
    if (m.subtype) return;
    if (m.channel_type !== 'im') return;
    if (!m.text) return;

    if (!m.thread_ts) {
      // Top-level DM (not a thread reply). We don't yet route these into
      // anything — they could be a fresh request someday, but for now
      // explain gently and ignore.
      await postReply(m.channel, m.ts, [
        "I only resume pipelines from thread replies right now.",
        'Reply in the thread of a paused pipeline DM to answer its blocker.',
      ].join(' ')).catch((err) => log.warn({ err }, 'failed to post top-level help'));
      return;
    }

    const pipeline = await getPipelineBySlackThread(m.thread_ts).catch((err) => {
      log.warn({ err, thread_ts: m.thread_ts }, 'getPipelineBySlackThread failed');
      return null;
    });

    if (!pipeline) {
      await postReply(m.channel, m.thread_ts, [
        "I don't recognize this thread —",
        "no paused pipeline is anchored to it.",
      ].join(' ')).catch((err) => log.warn({ err }, 'failed to post unknown-thread reply'));
      return;
    }

    const outcome = await claimAndResume(pipeline.id, m.text);

    if (outcome.ok) {
      log.info(
        { pipeline_id: pipeline.id, stage: outcome.stage },
        'slack reply resumed pipeline',
      );
      // No ack message — the next state transition (pause / awaiting_review /
      // failed) will post its own DM in this thread, which serves as the
      // implicit acknowledgement.
      return;
    }

    const reason =
      outcome.reason === 'not_paused'
        ? `not paused (status=${outcome.detail ?? 'unknown'})`
        : outcome.reason === 'not_found'
          ? 'pipeline not found'
          : outcome.reason === 'no_session'
            ? 'pipeline has no resumable session'
            : `unsupported stage: ${outcome.detail ?? 'null'}`;

    log.warn(
      { pipeline_id: pipeline.id, outcome },
      'slack reply could not resume pipeline',
    );
    await postReply(
      m.channel,
      m.thread_ts,
      `Couldn't resume pipeline \`${pipeline.id.slice(0, 8)}\` — ${reason}.`,
    ).catch((err) => log.warn({ err }, 'failed to post resume-failure reply'));
    return;
  }

  log.warn({ event_type: ev.type }, 'unhandled slack event');
}

async function postReply(
  channel: string,
  thread_ts: string,
  text: string,
): Promise<void> {
  await slackClient().chat.postMessage({ channel, thread_ts, text });
}
