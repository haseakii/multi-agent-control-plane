import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uiBuildId } from './ui-build.mjs';
import { runWorkbenchInstance } from './instance-lifecycle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration');
const data = path.join(run, 'data');
fs.mkdirSync(data, { recursive: true });
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { openSqliteStorage } = await load('packages/storage/dist/index.js');
const { createControlPlaneRuntime } = await load('apps/server/dist/runtime-composition.js');
const { readControlCenterSnapshot } = await load('apps/server/dist/control-center.js');
const { buildServer } = await load('apps/server/dist/server.js');
const { acquireInstanceLock } = await load('apps/server/dist/release-config.js');
const { closeHttpServer } = await load('apps/server/dist/http-shutdown.js');
const port = Number(process.env.HERMES_POC_PORT ?? '8046');
await runWorkbenchInstance({
  run, data, url: `http://127.0.0.1:${port}`, acquireLock: acquireInstanceLock,
}, async (instance) => {
  instance.assertRunning();
  const storage = instance.acquireResource(
    () => openSqliteStorage({ filename: path.join(data, 'state.sqlite') }),
    (storage) => storage.close(),
  );
  const runtime = instance.acquireResource(() => createControlPlaneRuntime({
    storage,
    workspaceRoot: path.join(data, 'workspaces'),
    artifactRoot: path.join(data, 'artifacts'),
    executionTimeoutMs: 60000,
  }), () => stopRuntime());
  let runtimeShutdown;
  const stopRuntime = () => runtimeShutdown ??= runtime.close();
  const app = instance.acquireResource(() => buildServer({
    agentControl: runtime.agentControl,
    taskControl: runtime,
    fleetGateway: runtime.fleetGateway,
    webRoot: path.join(run, 'web-dist'),
    controlCenter: () =>
      readControlCenterSnapshot(
        storage,
        (id) => runtime.agentControl.state(id),
        (id) => runtime.directoryBindings.confirmationVersion(id),
        (a) => runtime.approvalDecisionEligibility(a),
      ),
  }), (app) => closeHttpServer(app));
  app.addHook('preClose', stopRuntime);
  app.get('/api/workbench', async () => ({ mode: 'mock', uiBuildId: uiBuildId(run) }));
  const agents = [
    ['mock-planner', '规划负责人（本地模拟）', true],
    ['mock-reviewer', '审阅负责人（本地模拟）', true],
    ['mock-worker', '协作者（本地模拟）', false],
  ];
  for (const [id, name, boss] of agents) {
    instance.assertRunning();
    if (!storage.repositories.agentDefinitions.get(id)) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          id,
          name,
          enabled: true,
          runtime: {
            type: 'acp-stdio',
            command: process.execPath,
            args: [
              path.join(root, 'integrations/hermes-workbench/mock-agent.mjs'),
              ...(boss ? [] : ['--worker']),
            ],
          },
          auth: { mode: 'agent-managed' },
          capabilities: [{ name: boss ? 'planning' : 'code.review', source: 'configured' }],
          orchestration: { canBeBoss: boss },
          controlBridge: boss
            ? { transport: 'mcp', scopes: ['boss.orchestration', 'artifact.read'] }
            : { transport: 'none', scopes: [] },
        },
      });
      if (response.statusCode !== 201) throw Error(response.body);
    }
  }
  // This harness must never execute a real provider registered in another instance.
  if (storage.repositories.agentDefinitions.list().some((a) => !agents.some(([id]) => a.id === id)))
    throw Error('Verification data contains a non-mock agent; refusing to start.');
  instance.assertRunning();
  const url = await app.listen({ host: '127.0.0.1', port });
  runtime.setBridgeBaseUrl(url);
  for (const [id] of agents) {
    instance.assertRunning();
    const res = await app.inject({ method: 'POST', url: `/api/agents/${id}/probe` });
    if (res.statusCode !== 200) throw Error(res.body);
  }
  instance.ready({ data, realAgentPrompts: 0 });
  console.log(`Hermes workbench: ${url}`);
});
