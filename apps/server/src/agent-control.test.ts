import type { AgentRuntimeControl } from '@control-plane/acp-runtime';
import { ProjectSchema } from '@control-plane/core';
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

function setup() {
  const storage = openSqliteStorage({ filename: ':memory:' });
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

describe('agent registration, auth, and Boss controls', () => {
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
    expect(body.agents.every((agent: { readiness: { auth: string } }) => agent.readiness.auth === 'unknown')).toBe(true);
  });

  it('probes and authenticates agents independently without claiming auth state for others', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/agents', payload: definition('boss-agent', true) });
    await app.inject({ method: 'POST', url: '/api/agents', payload: definition('worker-agent', false) });

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

    const list = (await app.inject({ method: 'GET', url: '/api/agents' })).json();
    const worker = list.find((agent: { definition: { id: string } }) => agent.definition.id === 'worker-agent');
    expect(worker.readiness.auth).toBe('unknown');

    const workerProbe = await app.inject({ method: 'POST', url: '/api/agents/worker-agent/probe' });
    expect(workerProbe.json()).toMatchObject({ readiness: { auth: 'not_reported' } });
  });

  it('persists Boss selection and rejects agents outside the Boss bridge ceiling', async () => {
    const { app, storage } = setup();
    await app.inject({ method: 'POST', url: '/api/agents', payload: definition('boss-agent', true) });
    await app.inject({ method: 'POST', url: '/api/agents', payload: definition('worker-agent', false) });

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
    await app.inject({ method: 'POST', url: '/api/agents', payload: definition('boss-agent', true) });

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
