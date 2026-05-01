import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerBearerAuth } from './middleware/auth.js';
import { requestsRoute } from './routes/requests.js';
import { respondRoute } from './routes/respond.js';
import { slackRoute } from './routes/slack.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

registerBearerAuth(app);

app.get('/health', async () => ({ status: 'ok' }));

await app.register(requestsRoute);
await app.register(respondRoute);
await app.register(slackRoute);

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
