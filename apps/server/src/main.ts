import { AgentCatalogService, FileCatalogCache } from './agent-catalog.js';
import { dirname, join, resolve } from 'node:path';
import { openSqliteStorage } from '@control-plane/storage';
import { readControlCenterSnapshot, seedDemoState } from './control-center.js';
import { buildServer } from './server.js';
import { createControlPlaneRuntime } from './runtime-composition.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const filename = resolve(process.env.CONTROL_PLANE_DB ?? '.data/control-plane.sqlite');
const storage = openSqliteStorage({ filename });
const runtime = createControlPlaneRuntime({
  storage,
  artifactRoot: resolve(
    process.env.CONTROL_PLANE_ARTIFACTS ?? join(dirname(filename), 'artifacts'),
  ),
  workspaceRoot: resolve(
    process.env.CONTROL_PLANE_WORKSPACES ?? join(dirname(filename), 'workspaces'),
  ),
});

if (process.env.CONTROL_PLANE_DEMO === '1') {
  seedDemoState(storage);
}

const app = buildServer({
  fastify: { logger: true },
  agentControl: runtime.agentControl,
  agentCatalog: new AgentCatalogService(
    new FileCatalogCache(join(dirname(filename), 'cache/agent-catalog.json')),
    runtime.network.fetch,
  ),
  taskControl: runtime,
  fleetGateway: runtime.fleetGateway,
  controlCenter: (options) =>
    readControlCenterSnapshot(
      storage,
      (id) => runtime.agentControl.state(id),
      (id) => runtime.directoryBindings.confirmationVersion(id),
      (approval) => runtime.approvalDecisionEligibility(approval),
      options,
    ),
});

app.addHook('preClose', async () => {
  await runtime.close();
});
app.addHook('onClose', async () => {
  storage.close();
});

try {
  const address = await app.listen({ port, host });
  const bridgeAddress = new URL(address);
  if (bridgeAddress.hostname === '0.0.0.0') bridgeAddress.hostname = '127.0.0.1';
  if (bridgeAddress.hostname === '[::]') bridgeAddress.hostname = '[::1]';
  runtime.setBridgeBaseUrl(bridgeAddress.href);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
