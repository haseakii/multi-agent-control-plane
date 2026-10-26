import { expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { LocalRunner } from '@control-plane/runner';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
it('uses strict atomic network settings without spawning members or altering readiness, permissions or secrets', async () => {
  const storage = openSqliteStorage({ filename: ':memory:' }),
    runner = new LocalRunner();
  const spawn = vi.spyOn(runner, 'spawn');
  const runtime = createControlPlaneRuntime({ storage, runner });
  const app = buildServer({ taskControl: runtime, agentControl: runtime.agentControl });
  try {
    runtime.createProject({ id: 'p', name: 'Network API' });
    const policy = runtime.getProjectPolicy('p');
    runtime.agentControl.create({
      id: 'worker',
      name: 'Worker',
      enabled: true,
      runtime: { type: 'acp-stdio', command: process.execPath, args: [] },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
    const initial = (await app.inject({ method: 'GET', url: '/api/system/network' })).json();
    expect(initial).toMatchObject({
      revision: 0,
      global: { mode: 'unmanaged' },
      capabilities: { authentication: false },
    });
    const save = (payload: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/system/network', payload });
    const chosen = {
      expectedRevision: 0,
      global: { mode: 'proxy', proxyUrl: '127.0.0.1:7897' },
      members: { worker: { mode: 'direct' } },
    };
    const accepted = await save(chosen);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await save(chosen)).json().revision).toBe(1);
    expect(accepted.json()).toMatchObject({
      revision: 1,
      global: { proxyUrl: 'http://127.0.0.1:7897' },
      effective: [{ agentId: 'worker', source: 'member', mode: 'direct' }],
    });
    expect((await save({ ...chosen, global: { mode: 'direct' } })).statusCode).toBe(409);
    expect(
      (await save({ ...chosen, expectedRevision: 1, members: { missing: { mode: 'direct' } } }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await save({
          ...chosen,
          expectedRevision: 1,
          global: { mode: 'proxy', proxyUrl: 'http://user:synthetic-password@localhost:7897' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/system/network/test',
          payload: { choice: { mode: 'direct' }, target: 'http://arbitrary.invalid' },
        })
      ).statusCode,
    ).toBe(400);
    expect(runtime.network.repository.read().revision).toBe(1);
    expect(runtime.getProjectPolicy('p')).toEqual(policy);
    expect(runtime.agentControl.state('worker').readiness).toMatchObject({
      runtime: 'unknown',
      auth: 'unknown',
    });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await runtime.close();
    storage.close();
  }
});
