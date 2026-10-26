import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
import { deploymentContext, waitForDeployment } from './deployment-context.js';
it('keeps history/health readable while preventing new mutations until a verified deployment commits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deployment-gate-')),
    file = join(root, 'operation.json'),
    context = {
      installationId: randomUUID(),
      generationId: randomUUID(),
      releaseId: 'a'.repeat(64),
      operationFile: file,
    };
  const app = buildServer({ deployment: context });
  let writes = 0;
  app.post('/fixture', async () => ({ writes: ++writes }));
  try {
    writeFileSync(file, 'maintenance');
    expect((await app.inject('/health')).json()).toMatchObject({
      deployment: { installationId: context.installationId },
      maintenance: true,
    });
    expect((await app.inject({ method: 'POST', url: '/fixture' })).statusCode).toBe(503);
    expect(writes).toBe(0);
    const cancel = new AbortController();
    const waiting = waitForDeployment(context, cancel.signal);
    cancel.abort();
    await waiting;
    unlinkSync(file);
    expect((await app.inject({ method: 'POST', url: '/fixture' })).json()).toEqual({ writes: 1 });
    expect(deploymentContext(JSON.stringify(context))).toEqual(context);
    expect(() => deploymentContext('{}')).toThrow();
  } finally {
    await app.close();
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + '\\deployment-gate-') &&
      !resolve(root).startsWith(resolve(tmpdir()) + '/deployment-gate-')
    )
      throw Error('Unexpected path');
    rmSync(root, { recursive: true, force: true });
  }
});
