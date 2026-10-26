import type { AgentRuntimeControl } from '@control-plane/acp-runtime';
import { AgentConnectionFailure } from '@control-plane/acp-runtime';
import {
  ProjectSchema,
  TaskSchema,
  AssignmentSchema,
  ExecutionAttemptSchema,
} from '@control-plane/core';
import type { ExecutionAttempt } from '@control-plane/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '@control-plane/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentControlService } from './agent-control.js';
import { readControlCenterSnapshot } from './control-center.js';
import { buildServer } from './server.js';

function definition(id: string, boss: boolean) {
  return {
    id,
    name: id,
    enabled: true,
    runtime: {
      type: 'acp-stdio' as const,
      command: process.execPath,
      args: ['--version'],
    },
    capabilities: [{ name: boss ? 'planning' : 'code.read', source: 'configured' as const }],
    auth: { mode: 'agent-managed' as const },
    orchestration: { canBeBoss: boss },
    controlBridge: boss
      ? {
          transport: 'mcp' as const,
          scopes: ['boss.orchestration' as const, 'agent.messaging' as const],
        }
      : { transport: 'none' as const, scopes: [] },
  };
}

function runtime(): AgentRuntimeControl {
  return {
    probe: vi.fn(async (agent) =>
      agent.id === 'worker-agent'
        ? {
            readiness: {
              runtime: 'ready' as const,
              auth: 'not_reported' as const,
              observedAt: '2026-10-20T08:00:00.000Z',
              authMethodIds: [],
            },
            authMethods: [],
          }
        : {
            readiness: {
              runtime: 'ready' as const,
              auth: 'unknown' as const,
              observedAt: '2026-10-20T08:00:00.000Z',
              authMethodIds: ['agent-login'],
            },
            authMethods: [{ id: 'agent-login', name: 'Agent login' }],
          },
    ),
    authenticate: vi.fn(async () => ({
      readiness: {
        runtime: 'ready' as const,
        auth: 'ready' as const,
        observedAt: '2026-10-20T08:01:00.000Z',
        authMethodIds: ['agent-login'],
      },
      authMethods: [{ id: 'agent-login', name: 'Agent login' }],
    })),
  };
}

const apps: ReturnType<typeof buildServer>[] = [];
const storages: ReturnType<typeof openSqliteStorage>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const storage of storages.splice(0)) {
    storage.close();
  }
});

function setup(filename = ':memory:') {
  const storage = openSqliteStorage({ filename });
  storages.push(storage);
  storage.repositories.projects.upsert(
    ProjectSchema.parse({
      id: 'project-1',
      name: 'Project',
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
    }),
  );
  const service = new AgentControlService(storage, runtime(), {
    now: () => '2026-10-20T08:02:00.000Z',
  });
  const app = buildServer({
    agentControl: service,
    controlCenter: () => readControlCenterSnapshot(storage, (id) => service.state(id)),
  });
  apps.push(app);
  return { app, storage, service };
}

it('rejects stale configuration saves atomically while keeping current configuration and readiness', async () => {
  const { app, service } = setup();
  const created = service.create(definition('worker-agent', false));
  expect(created.definitionHash).toMatch(/^[a-f0-9]{64}$/);
  const observed = await service.probe('worker-agent');
  expect(observed.definitionHash).toBe(created.definitionHash);
  const updated = await app.inject({
    method: 'PATCH',
    url: '/api/agents/worker-agent',
    payload: { name: 'Changed elsewhere', expectedDefinitionHash: created.definitionHash },
  });
  expect(updated.statusCode).toBe(200);
  const latest = updated.json();
  expect(latest.definitionHash).not.toBe(created.definitionHash);
  expect(latest.readiness).toEqual(observed.readiness);
  const stale = await app.inject({
    method: 'PATCH',
    url: '/api/agents/worker-agent',
    payload: {
      name: 'Stale editor',
      enabled: false,
      expectedDefinitionHash: created.definitionHash,
    },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('AGENT_CONFIGURATION_CHANGED');
  expect(service.list()[0]).toEqual(latest);
  const retried = await app.inject({
    method: 'PATCH',
    url: '/api/agents/worker-agent',
    payload: { name: 'Reviewed merge', expectedDefinitionHash: latest.definitionHash },
  });
  expect(retried.statusCode).toBe(200);
  expect(retried.json().definition.name).toBe('Reviewed merge');
  expect(retried.json().readiness).toEqual(observed.readiness);
  const malformed = await app.inject({
    method: 'PATCH',
    url: '/api/agents/worker-agent',
    payload: { name: 'No write', expectedDefinitionHash: 123 },
  });
  expect(malformed.statusCode).toBe(400);
  expect(service.list()[0]?.definition.name).toBe('Reviewed merge');
});

it('exposes fixed connection diagnoses but keeps unexpected adapter errors private', async () => {
  const { storage } = setup();
  const adapter = runtime();
  const service = new AgentControlService(storage, adapter);
  service.create(definition('diagnostic', false));
  vi.mocked(adapter.probe).mockRejectedValueOnce(new AgentConnectionFailure('access_denied'));
  const diagnosed = await service.probe('diagnostic');
  expect(diagnosed.readiness.runtime).toBe('error');
  expect(diagnosed.error).toContain('系统拒绝启动程序');
  vi.mocked(adapter.probe).mockRejectedValueOnce(new Error('Bearer private-provider-output'));
  expect((await service.probe('diagnostic')).error).toBe('Agent probe failed.');
  await service.probe('diagnostic');
  vi.mocked(adapter.authenticate).mockRejectedValueOnce(
    new AgentConnectionFailure('authentication_failed'),
  );
  await expect(service.authenticate('diagnostic', 'agent-login')).rejects.toMatchObject({
    statusCode: 502,
  });
  expect(service.state('diagnostic').error).toContain('登录确认未完成');
});

it('warms a configured login in one connection and retains negotiated methods on a transient failure', async () => {
  const { storage } = setup();
  const adapter = runtime();
  const service = new AgentControlService(storage, adapter);
  service.create(definition('warm', false));
  const observed = await adapter.probe(definition('warm', false));
  vi.mocked(adapter.probe).mockClear();
  vi.mocked(adapter.authenticate).mockRejectedValueOnce(
    new AgentConnectionFailure('authentication_unavailable', observed),
  );
  await expect(service.warmAuthentication('warm', 'agent-login')).rejects.toMatchObject({
    code: 'authentication_unavailable',
  });
  expect(adapter.probe).not.toHaveBeenCalled();
  expect(service.state('warm').readiness).toMatchObject({ runtime: 'ready', auth: 'unknown' });
  expect(service.state('warm').authMethods).toEqual(observed.authMethods);
  expect((await service.authenticate('warm', 'agent-login')).readiness.auth).toBe('ready');
  expect(adapter.authenticate).toHaveBeenCalledTimes(2);
  vi.mocked(adapter.authenticate).mockRejectedValueOnce(
    new AgentConnectionFailure('missing_entry'),
  );
  await expect(service.warmAuthentication('warm', 'agent-login')).rejects.toMatchObject({
    code: 'missing_entry',
  });
  expect(service.state('warm').readiness.runtime).toBe('error');
});

function savedAttempt(
  storage: ReturnType<typeof openSqliteStorage>,
  agentId: string,
  state: ExecutionAttempt['state'],
) {
  const timestamp = '2026-10-20T08:00:00.000Z';
  const task = storage.repositories.tasks.upsert(
    TaskSchema.parse({
      id: `task-${agentId}`,
      projectId: 'project-1',
      title: 'Saved work',
      objective: 'Keep working',
      state: 'waiting',
      ownerAgentId: agentId,
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const assignment = storage.repositories.assignments.upsert(
    AssignmentSchema.parse({
      id: `assignment-${agentId}`,
      taskId: task.id,
      agentId,
      objective: task.objective,
      state: state === 'interrupted' ? 'waiting' : state,
      attempt: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  return storage.repositories.executionAttempts.upsert(
    ExecutionAttemptSchema.parse({
      id: `attempt-${agentId}`,
      taskId: task.id,
      assignmentId: assignment.id,
      number: 1,
      state,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
}

describe('agent registration, auth, and Boss controls', () => {
  it.each(['queued', 'running', 'waiting'] as const)(
    'keeps launch configuration stable for %s attempts while allowing immediate authority reduction',
    async (state) => {
      const { app, storage, service } = setup();
      const original = service.create(definition('busy', true)).definition;
      savedAttempt(storage, 'busy', state);
      await service.probe('busy');
      await service.authenticate('busy', 'agent-login');
      for (const patch of [
        { runtime: { ...original.runtime, args: ['new-entry.js'] } },
        { auth: { mode: 'secret-ref', secretRef: 'new-profile' } },
        { runnerSelector: { os: 'linux' } },
        { permissions: 'different-policy' },
        { controlBridge: { transport: 'cli', scopes: original.controlBridge.scopes } },
        {
          controlBridge: {
            transport: 'mcp',
            scopes: [...original.controlBridge.scopes, 'artifact.publish'],
          },
        },
      ]) {
        const denied = await app.inject({
          method: 'PATCH',
          url: '/api/agents/busy',
          payload: patch,
        });
        expect(denied.statusCode).toBe(409);
        expect(denied.json().error).toContain('停止任务或等待完成');
        expect(storage.repositories.agentDefinitions.get('busy')).toEqual(original);
        expect(service.state(original.id).readiness.auth).toBe('ready');
      }
      // Revocation must stay usable while an already-authorized MCP call is in flight.
      expect(
        service.update('busy', {
          enabled: false,
          orchestration: { canBeBoss: false },
          controlBridge: { transport: 'mcp', scopes: ['agent.messaging'] },
          name: 'Renamed while working',
        }).definition,
      ).toMatchObject({ enabled: false, orchestration: { canBeBoss: false } });
      for (const patch of [
        { enabled: true },
        { orchestration: { canBeBoss: true } },
        { controlBridge: original.controlBridge },
      ]) {
        const denied = await app.inject({
          method: 'PATCH',
          url: '/api/agents/busy',
          payload: patch,
        });
        expect(denied.statusCode).toBe(409);
      }
      expect(
        service.update('busy', { controlBridge: { transport: 'none', scopes: [] } }).definition
          .controlBridge.transport,
      ).toBe('none');
      // These inspect a separate connection and do not rewrite the running attempt.
      expect((await app.inject({ method: 'POST', url: '/api/agents/busy/probe' })).statusCode).toBe(
        200,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/agents/busy/auth',
            payload: { methodId: 'agent-login' },
          })
        ).statusCode,
      ).toBe(200);
      expect(storage.repositories.executionAttempts.get('attempt-busy')?.state).toBe(state);
    },
  );

  it('allows changes after interruption even if the saved assignment is waiting or another Agent is active', () => {
    const { storage, service } = setup();
    service.create(definition('interrupted', false));
    service.create(definition('other', false));
    savedAttempt(storage, 'interrupted', 'interrupted');
    savedAttempt(storage, 'other', 'running');
    const updated = service.update('interrupted', {
      runtime: { type: 'acp-stdio', command: process.execPath, args: ['replacement.js'] },
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    });
    expect(updated.definition.runtime.args).toEqual(['replacement.js']);
    expect(updated.definition.orchestration.canBeBoss).toBe(true);
  });

  it('removes an unused registration through HTTP and persists removal across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-removal-'));
    const filename = join(directory, 'state.sqlite');
    const { app, storage, service } = setup(filename);
    try {
      service.create(definition('unused', true));
      service.selectBoss('project-1', 'unused');
      service.update('unused', { enabled: false });
      const before = await app.inject({ method: 'GET', url: '/api/agents/unused/removal' });
      expect(before.json()).toMatchObject({
        canRemove: false,
        references: [{ kind: 'project', count: 1 }],
      });
      const clear = await app.inject({
        method: 'PUT',
        url: '/api/projects/project-1/boss',
        payload: { agentId: null },
      });
      expect(clear.statusCode).toBe(200);
      const preview = (
        await app.inject({ method: 'GET', url: '/api/agents/unused/removal' })
      ).json();
      expect(preview.canRemove).toBe(true);
      const removed = await app.inject({
        method: 'DELETE',
        url: '/api/agents/unused',
        payload: { confirmedAgentId: preview.agentId, definitionHash: preview.definitionHash },
      });
      expect(removed.statusCode).toBe(200);
      expect(storage.repositories.agentDefinitions.get('unused')).toBeUndefined();
      await app.close();
      apps.splice(apps.indexOf(app), 1);
      storage.close();
      storages.splice(storages.indexOf(storage), 1);
      const reopened = openSqliteStorage({ filename });
      try {
        expect(reopened.repositories.agentDefinitions.get('unused')).toBeUndefined();
        expect(reopened.repositories.projects.get('project-1')).toMatchObject({ name: 'Project' });
        expect(reopened.repositories.projects.get('project-1')?.defaultBossAgentId).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      if (apps.includes(app)) {
        await app.close();
        apps.splice(apps.indexOf(app), 1);
      }
      if (storages.includes(storage)) {
        storage.close();
        storages.splice(storages.indexOf(storage), 1);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps referenced Agent and task history when removal is requested', async () => {
    const { app, storage, service } = setup();
    service.create(definition('used', false));
    const task = TaskSchema.parse({
      id: 'task-used',
      projectId: 'project-1',
      title: 'Saved work',
      objective: 'Retain execution history',
      state: 'completed',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      ownerAgentId: 'used',
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
    });
    storage.repositories.tasks.upsert(task);
    service.update('used', { enabled: false });
    const preview = service.removalPreview('used');
    expect(preview.references).toContainEqual({ kind: 'task', count: 1 });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/agents/used',
      payload: { confirmedAgentId: preview.agentId, definitionHash: preview.definitionHash },
    });
    expect(response.statusCode).toBe(409);
    expect(storage.repositories.tasks.get(task.id)).toEqual(task);
    expect(storage.repositories.agentDefinitions.get('used')).toMatchObject({ enabled: false });
  });

  it('persists arbitrary ACP definitions and keeps unprobed auth state unknown', async () => {
    const { app, storage } = setup();

    const boss = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('boss-agent', true),
    });
    const worker = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('worker-agent', false),
    });

    expect(boss.statusCode).toBe(201);
    expect(worker.statusCode).toBe(201);
    expect(storage.repositories.agentDefinitions.list()).toHaveLength(2);

    const snapshot = await app.inject({ method: 'GET', url: '/api/control-center' });
    const body = snapshot.json();
    expect(body.agents).toHaveLength(2);
    expect(
      body.agents.every(
        (agent: { readiness: { auth: string } }) => agent.readiness.auth === 'unknown',
      ),
    ).toBe(true);
  });

  it('probes and authenticates agents independently without claiming auth state for others', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('boss-agent', true),
    });
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('worker-agent', false),
    });

    const probed = await app.inject({ method: 'POST', url: '/api/agents/boss-agent/probe' });
    expect(probed.statusCode).toBe(200);
    expect(probed.json()).toMatchObject({
      readiness: { runtime: 'ready', auth: 'unknown' },
      authMethods: [{ id: 'agent-login', name: 'Agent login' }],
    });

    const authenticated = await app.inject({
      method: 'POST',
      url: '/api/agents/boss-agent/auth',
      payload: { methodId: 'agent-login' },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({ readiness: { auth: 'ready' } });

    // Repeated connection checks only initialize fresh ACP processes; an
    // unreported login status must not undo a successful explicit confirmation.
    for (let check = 0; check < 2; check++) {
      const checked = await app.inject({ method: 'POST', url: '/api/agents/boss-agent/probe' });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ readiness: { runtime: 'ready', auth: 'ready' } });
    }

    const list = (await app.inject({ method: 'GET', url: '/api/agents' })).json();
    const worker = list.find(
      (agent: { definition: { id: string } }) => agent.definition.id === 'worker-agent',
    );
    expect(worker.readiness.auth).toBe('unknown');

    const workerProbe = await app.inject({ method: 'POST', url: '/api/agents/worker-agent/probe' });
    expect(workerProbe.json()).toMatchObject({ readiness: { auth: 'not_reported' } });
  });

  it('honors an explicit login requirement and clears confirmed auth after configuration changes', async () => {
    const { storage } = setup();
    const adapter = runtime();
    const service = new AgentControlService(storage, adapter);
    service.create(definition('login-check', false));
    await service.probe('login-check');
    await service.authenticate('login-check', 'agent-login');
    expect(service.state('login-check').readiness.auth).toBe('ready');

    const unknown = await runtime().probe(definition('login-check', false));
    vi.mocked(adapter.probe).mockResolvedValueOnce({
      ...unknown,
      readiness: { ...unknown.readiness, auth: 'needs_login' },
    });
    expect((await service.probe('login-check')).readiness.auth).toBe('needs_login');
    expect((await service.probe('login-check')).readiness.auth).toBe('needs_login');

    await service.authenticate('login-check', 'agent-login');
    service.update('login-check', {
      runtime: { ...definition('login-check', false).runtime, args: ['different-entry'] },
    });
    expect((await service.probe('login-check')).readiness.auth).toBe('unknown');
    expect(adapter.authenticate).toHaveBeenCalledTimes(2);
  });

  it('persists Boss selection and rejects agents outside the Boss bridge ceiling', async () => {
    const { app, storage } = setup();
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('boss-agent', true),
    });
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('worker-agent', false),
    });

    const selected = await app.inject({
      method: 'PUT',
      url: '/api/projects/project-1/boss',
      payload: { agentId: 'boss-agent' },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ defaultBossAgentId: 'boss-agent' });
    expect(storage.repositories.projects.get('project-1')?.defaultBossAgentId).toBe('boss-agent');

    const denied = await app.inject({
      method: 'PUT',
      url: '/api/projects/project-1/boss',
      payload: { agentId: 'worker-agent' },
    });
    expect(denied.statusCode).toBe(400);
  });

  it('supports validated updates while preventing agent id changes', async () => {
    const { app, storage } = setup();
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: definition('boss-agent', true),
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/agents/boss-agent',
      payload: { name: 'Renamed Boss', enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(storage.repositories.agentDefinitions.get('boss-agent')?.name).toBe('Renamed Boss');

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/agents/boss-agent',
      payload: { id: 'other-agent' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

it.each(['success', 'failure'])(
  'ignores obsolete probe %s after configuration changes',
  async (outcome) => {
    const { storage } = setup();
    let resolve!: (v: Awaited<ReturnType<AgentRuntimeControl['probe']>>) => void;
    let reject!: (e: Error) => void;
    const pending = new Promise<Awaited<ReturnType<AgentRuntimeControl['probe']>>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const control = new AgentControlService(storage, {
      probe: () => pending,
      authenticate: runtime().authenticate,
    });
    control.create(definition('race', false));
    const request = control.probe('race');
    control.update('race', {
      name: 'new configuration',
      runtime: { ...definition('race', false).runtime, args: ['changed.js'] },
    });
    if (outcome === 'success') resolve(await runtime().probe(definition('worker-agent', false)));
    else reject(new Error('old failure'));
    await request;
    expect(control.state('race').readiness.runtime).toBe('unknown');
  },
);
it('keeps the latest overlapping probe result', async () => {
  const { storage } = setup();
  let first!: (v: Awaited<ReturnType<AgentRuntimeControl['probe']>>) => void;
  const control = new AgentControlService(storage, {
    probe: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            first = r;
          }),
      )
      .mockResolvedValue({
        readiness: { runtime: 'ready', auth: 'ready', observedAt: 'new', authMethodIds: [] },
        authMethods: [],
      }),
    authenticate: runtime().authenticate,
  });
  control.create(definition('race', false));
  const old = control.probe('race');
  await control.probe('race');
  first(await runtime().probe(definition('worker-agent', false)));
  await old;
  expect(control.state('race').readiness.observedAt).toBe('new');
});
it.each(['success', 'failure'])(
  'ignores obsolete authentication %s after update',
  async (outcome) => {
    const { storage } = setup();
    let resolve!: (v: Awaited<ReturnType<AgentRuntimeControl['probe']>>) => void;
    let reject!: (e: Error) => void;
    const control = new AgentControlService(storage, {
      probe: runtime().probe,
      authenticate: () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    });
    control.create(definition('race', false));
    await control.probe('race');
    const pending = control.authenticate('race', 'agent-login').catch(() => undefined);
    control.update('race', {
      name: 'new',
      runtime: { ...definition('race', false).runtime, args: ['changed.js'] },
    });
    if (outcome === 'success')
      resolve(await runtime().authenticate(definition('race', false), 'agent-login'));
    else reject(new Error('old'));
    await pending;
    expect(control.state('race').readiness.runtime).toBe('unknown');
  },
);
it('keeps confirmed readiness for metadata-only and no-op updates without probing or signing in again', async () => {
  const { storage } = setup();
  const adapter = runtime();
  const control = new AgentControlService(storage, adapter);
  control.create(definition('metadata', true));
  await control.probe('metadata');
  const confirmed = await control.authenticate('metadata', 'agent-login');
  const updated = control.update('metadata', {
    name: 'Friendly name',
    description: 'Description',
    capabilities: [{ name: 'writing', source: 'configured' }],
  });
  expect(updated.readiness).toEqual(confirmed.readiness);
  expect(updated.authMethods).toEqual(confirmed.authMethods);
  expect(control.update('metadata', updated.definition).readiness).toEqual(confirmed.readiness);
  expect(adapter.probe).toHaveBeenCalledTimes(1);
  expect(adapter.authenticate).toHaveBeenCalledTimes(1);
  const changed = control.update('metadata', { controlBridge: { transport: 'none', scopes: [] } });
  expect(changed.readiness).toMatchObject({ runtime: 'unknown', auth: 'unknown' });
});

it.each(['probe', 'authenticate'] as const)(
  'retains in-flight %s results after renaming and returns the latest definition',
  async (operation) => {
    const { storage } = setup();
    const adapter = runtime();
    const control = new AgentControlService(storage, adapter);
    control.create(definition('renamed', false));
    await control.probe('renamed');
    let complete!: (value: Awaited<ReturnType<AgentRuntimeControl['probe']>>) => void;
    const pending = new Promise<Awaited<ReturnType<AgentRuntimeControl['probe']>>>((resolve) => {
      complete = resolve;
    });
    vi.mocked(adapter[operation]).mockImplementationOnce(() => pending);
    const request =
      operation === 'probe'
        ? control.probe('renamed')
        : control.authenticate('renamed', 'agent-login');
    control.update('renamed', { name: 'New label' });
    const observation = await runtime().authenticate(definition('renamed', false), 'agent-login');
    complete(observation);
    const result = await request;
    expect(result.definition.name).toBe('New label');
    expect(result.readiness).toEqual(observation.readiness);
  },
);
