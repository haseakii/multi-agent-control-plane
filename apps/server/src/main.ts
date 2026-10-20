import { resolve } from 'node:path';
import { openSqliteStorage } from '@control-plane/storage';
import { readControlCenterSnapshot, seedDemoState } from './control-center.js';
import { buildServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const filename = resolve(process.env.CONTROL_PLANE_DB ?? '.data/control-plane.sqlite');
const storage = openSqliteStorage({ filename });

if (process.env.CONTROL_PLANE_DEMO === '1') {
  seedDemoState(storage);
}

const app = buildServer({
  fastify: { logger: true },
  controlCenter: () => readControlCenterSnapshot(storage),
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
