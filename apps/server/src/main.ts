import { resolve } from 'node:path';
import { ProcessAgentRuntimeControl } from '@control-plane/acp-runtime';
import { LocalRunner } from '@control-plane/runner';
import { openSqliteStorage } from '@control-plane/storage';
import { AgentControlService } from './agent-control.js';
import { readControlCenterSnapshot, seedDemoState } from './control-center.js';
import { buildServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const filename = resolve(process.env.CONTROL_PLANE_DB ?? '.data/control-plane.sqlite');
const storage = openSqliteStorage({ filename });
const runner = new LocalRunner({ id: 'local' });
storage.repositories.runners.upsert(runner.descriptor());
const agentControl = new AgentControlService(
  storage,
  new ProcessAgentRuntimeControl(runner),
);

if (process.env.CONTROL_PLANE_DEMO === '1') {
  seedDemoState(storage);
}

const app = buildServer({
  fastify: { logger: true },
  agentControl,
  controlCenter: () => readControlCenterSnapshot(storage, (id) => agentControl.state(id)),
});

app.addHook('onClose', async () => {
  storage.close();
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
