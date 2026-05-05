import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

const PUBLIC_PATHS = new Set(['/health']);
const PUBLIC_PREFIXES = ['/slack/', '/github/'];

export function registerBearerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
    if (PUBLIC_PATHS.has(path)) return;
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;

    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer token' });
    }
    const token = header.slice('Bearer '.length).trim();
    if (token !== env.KRAHNBORN_API_TOKEN) {
      return reply.code(401).send({ error: 'invalid bearer token' });
    }
  });
}
