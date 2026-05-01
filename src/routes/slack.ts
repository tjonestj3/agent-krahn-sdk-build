import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
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

    log.info(
      {
        slack_user: m.user,
        channel: m.channel,
        ts: m.ts,
        thread_ts: m.thread_ts,
        text: m.text,
      },
      'slack DM received (M3 — not yet routed to pipeline)',
    );
    return;
  }

  log.warn({ event_type: ev.type }, 'unhandled slack event');
}
