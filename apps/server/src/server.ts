import Fastify, { type FastifyServerOptions } from 'fastify';
import type { ControlCenterSnapshot } from './control-center.js';

export type ControlCenterProvider = () => Promise<ControlCenterSnapshot> | ControlCenterSnapshot;

export type BuildServerOptions = {
  fastify?: FastifyServerOptions;
  controlCenter?: ControlCenterProvider;
};

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify(options.fastify ?? {});

  app.get('/health', async () => ({
    status: 'ok' as const,
    service: 'multi-agent-control-plane',
  }));

  app.get('/api/control-center', async () => {
    if (!options.controlCenter) {
      return {
        generatedAt: new Date().toISOString(),
        projects: [],
        agents: [],
        tasks: [],
        assignments: [],
        timeline: [],
        messages: [],
        approvals: [],
        artifacts: [],
        runners: [],
        workspaces: [],
      } satisfies ControlCenterSnapshot;
    }
    return options.controlCenter();
  });

  return app;
}
