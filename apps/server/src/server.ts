import Fastify, { type FastifyServerOptions } from 'fastify';
import type { ControlCenterSnapshot } from './control-center.js';
import { registerFleetBridgeGateway, type FleetBridgeGatewayOptions } from './fleet-gateway.js';

export type ControlCenterProvider = () => Promise<ControlCenterSnapshot> | ControlCenterSnapshot;

export type BuildServerOptions = {
  fastify?: FastifyServerOptions;
  controlCenter?: ControlCenterProvider;
  fleetGateway?: FleetBridgeGatewayOptions;
};

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify(options.fastify ?? {});

  if (options.fleetGateway) {
    registerFleetBridgeGateway(app, options.fleetGateway);
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
