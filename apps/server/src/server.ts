import Fastify, { type FastifyServerOptions } from 'fastify';

export function buildServer(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get('/health', async () => ({
    status: 'ok' as const,
    service: 'multi-agent-control-plane',
  }));

  return app;
}
