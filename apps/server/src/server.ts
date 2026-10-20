import Fastify, { type FastifyServerOptions } from 'fastify';
import type { ControlCenterSnapshot } from './control-center.js';
import { registerAgentControlRoutes, type AgentControlService } from './agent-control.js';
import { registerFleetBridgeGateway, type FleetBridgeGatewayOptions } from './fleet-gateway.js';
import { registerTaskControlRoutes } from './task-control.js';
import type { ControlPlaneRuntime } from './runtime-composition.js';

export type ControlCenterProvider = () => Promise<ControlCenterSnapshot> | ControlCenterSnapshot;

export type BuildServerOptions = {
  fastify?: FastifyServerOptions;
  controlCenter?: ControlCenterProvider;
  fleetGateway?: FleetBridgeGatewayOptions;
  agentControl?: AgentControlService;
  taskControl?: ControlPlaneRuntime;
};

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify(options.fastify ?? {});

  // Local-owner API, not a multi-user service. Reject DNS rebinding and foreign
  // browser origins; this does not authenticate other processes of the same user.
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    try {
      if (!host || /[\s/@\\,]/.test(host)) throw new Error('Invalid host.');
      const local = new URL(`http://${host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) {
        throw new Error('Non-local host.');
      }
      const origin = request.headers.origin;
      if (origin) {
        const parsed = new URL(origin);
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.origin !== origin ||
          parsed.host.toLowerCase() !== host.toLowerCase()
        ) {
          throw new Error('Foreign browser origin.');
        }
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        throw new Error('Cross-site request.');
      }
    } catch {
      return reply.code(403).send({ error: 'Only local, same-origin requests are accepted.' });
    }
  });

  if (options.fleetGateway) {
    registerFleetBridgeGateway(app, options.fleetGateway);
  }
  if (options.agentControl) {
    registerAgentControlRoutes(app, options.agentControl);
  }
  if (options.taskControl) {
    registerTaskControlRoutes(app, options.taskControl);
  }

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
