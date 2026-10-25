import { registerAgentCatalogRoutes, type AgentCatalogService } from './agent-catalog.js';
import { registerWebUi } from './web-ui.js';
import { registerHttpShutdown } from './http-shutdown.js';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  ApprovalRecordIntegrityError,
  PermissionInspectionLimitError,
} from '@control-plane/storage';
import type { ControlCenterSnapshot } from './control-center.js';
import {
  ControlCenterQuery,
  conversationSnapshot,
  type ControlCenterReadOptions,
} from './conversation-snapshot.js';
import { registerAgentControlRoutes, type AgentControlService } from './agent-control.js';
import { registerFleetBridgeGateway, type FleetBridgeGatewayOptions } from './fleet-gateway.js';
import { registerTaskControlRoutes } from './task-control.js';
import { registerClientGateway, type ClientGatewayOptions } from './client-gateway.js';
import type { ControlPlaneRuntime } from './runtime-composition.js';
import { registerNetworkSettingsRoutes } from './network-settings-routes.js';
import { registerInputAttachmentRoutes } from './input-attachment-routes.js';

export type ControlCenterProvider = (
  options?: ControlCenterReadOptions,
) => Promise<ControlCenterSnapshot> | ControlCenterSnapshot;

export type BuildServerOptions = {
  fastify?: FastifyServerOptions;
  webRoot?: string;
  controlCenter?: ControlCenterProvider;
  fleetGateway?: FleetBridgeGatewayOptions;
  clientGateway?: ClientGatewayOptions;
  agentControl?: AgentControlService;
  agentCatalog?: AgentCatalogService;
  taskControl?: ControlPlaneRuntime;
};

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify(options.fastify ?? {});
  registerHttpShutdown(app);

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
      // Opening a bookmark/task link must load the inert entry document. Its
      // query selects a conversation in the UI; it does not execute an action.
      // API calls,
      // embedded documents and asset fetches still require a local origin.
      const entryNavigation =
        request.method === 'GET' &&
        request.url.split('?', 1)[0] === '/' &&
        request.headers['sec-fetch-mode'] === 'navigate' &&
        request.headers['sec-fetch-dest'] === 'document';
      if (request.headers['sec-fetch-site'] === 'cross-site' && !entryNavigation) {
        throw new Error('Cross-site request.');
      }
    } catch {
      return reply.code(403).send({ error: 'Only local, same-origin requests are accepted.' });
    }
  });

  if (options.fleetGateway) {
    registerFleetBridgeGateway(app, options.fleetGateway);
  }
  if (options.clientGateway) registerClientGateway(app, options.clientGateway);
  if (options.agentControl) {
    registerAgentControlRoutes(app, options.agentControl);
    if (options.agentCatalog)
      registerAgentCatalogRoutes(app, options.agentCatalog, options.agentControl);
  }
  if (options.taskControl) {
    registerTaskControlRoutes(app, options.taskControl);
    registerNetworkSettingsRoutes(app, options.taskControl.network);
    registerInputAttachmentRoutes(app, options.taskControl.inputAttachments);
  }

  app.get('/health', async () => ({
    status: 'ok' as const,
    service: 'multi-agent-control-plane',
  }));

  app.get('/api/control-center', async (request, reply) => {
    const query = ControlCenterQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid control-center query.' });
    try {
      const snapshot = options.controlCenter
        ? await options.controlCenter(query.data)
        : ({
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
          } satisfies ControlCenterSnapshot);
      return query.data.view === 'conversation'
        ? conversationSnapshot(snapshot, query.data.taskId)
        : snapshot;
    } catch (error) {
      if (
        error instanceof ApprovalRecordIntegrityError ||
        error instanceof PermissionInspectionLimitError
      )
        return reply.code(500).send({ error: 'Approval storage read failed.', code: error.code });
      throw error;
    }
  });

  if (options.webRoot) registerWebUi(app, options.webRoot);

  return app;
}
