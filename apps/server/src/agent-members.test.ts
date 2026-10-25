import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { AgentMembersService } from './agent-members.js';
import { AgentInstallationsService } from './agent-installations.js';
import { AgentCatalogService, OFFICIAL_CATALOG_URL } from './agent-catalog.js';
import { buildServer } from './server.js';
const worker = {
  type: 'acp-stdio' as const,
  command: process.execPath,
  args: [fileURLToPath(new URL('../fixtures/client-worker-agent.mjs', import.meta.url))],
};
it('creates independently addressable members from an existing program without changing the source or its authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-members-')),
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const members = new AgentMembersService(storage, runtime.agentControl),
    app = buildServer({ agentControl: runtime.agentControl, agentMembers: members });
  try {
    runtime.agentControl.create({
      id: 'original',
      name: 'Installed program',
      enabled: true,
      runtime: worker,
      capabilities: [],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'none', scopes: [] },
    });
    const source = storage.repositories.agentDefinitions.get('original');
    const body = { requestId: randomUUID(), name: 'Page developer' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/agents/original/members',
      payload: body,
    });
    expect(first.statusCode, first.body).toBe(200);
    const id = first.json().member.definition.id;
    expect(first.json()).toMatchObject({ ready: true, reused: false });
    const again = await app.inject({
      method: 'POST',
      url: '/api/agents/original/members',
      payload: body,
    });
    expect(again.json()).toMatchObject({ reused: true, member: { definition: { id } } });
    const second = await members.fromAgent('original', {
      requestId: randomUUID(),
      name: 'Code reviewer',
    });
    expect(second.member.definition.id).not.toBe(id);
    expect(runtime.agentControl.list()).toHaveLength(3);
    expect(second.member.definition.runtime).toEqual(worker);
    expect(second.member.definition.orchestration.canBeBoss).toBe(false);
    expect(second.member.definition.auth).toEqual({ mode: 'agent-managed' });
    expect(storage.repositories.agentDefinitions.get('original')).toEqual(source);
    expect(storage.repositories.agentMemberOrigins.get(id)?.sourceAgentId).toBe('original');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents/original/members',
          payload: { ...body, name: 'Changed' },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await members.settle();
    await app.close();
    await runtime.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
it('creates multiple members from a durable installed package with an empty registry and no reinstall', async () => {
  const root = mkdtempSync(join(tmpdir(), 'package-members-')),
    filename = join(root, 'state.sqlite'),
    storage = openSqliteStorage({ filename });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const members = new AgentMembersService(storage, runtime.agentControl),
    install = vi.fn();
  const installations = new AgentInstallationsService({
    storage,
    catalog: new AgentCatalogService(),
    agents: runtime.agentControl,
    network: runtime.network,
    root: join(root, 'agents'),
    releaseRoot: root,
    members,
    installPackage: install,
  });
  const id = randomUUID(),
    at = '2026-10-25T00:00:00Z';
  storage.repositories.agentInstallations.upsert({
    id,
    entryId: 'fixture-worker',
    version: '1.0.0',
    planHash: 'a'.repeat(64),
    state: 'ready',
    message: 'Installed',
    createdAt: at,
    updatedAt: at,
    package: {
      runtime: worker,
      origin: 'installation',
      source: {
        entryId: 'fixture-worker',
        entryName: 'Fixture Worker',
        catalogVersion: '1.0.0',
        catalogUrl: OFFICIAL_CATALOG_URL,
      },
    },
  });
  try {
    const first = await installations.createMember(id, { requestId: randomUUID(), name: 'First' }),
      second = await installations.createMember(id, { requestId: randomUUID(), name: 'Second' });
    expect(first.ready && second.ready).toBe(true);
    expect(install).not.toHaveBeenCalled();
    expect(
      installations
        .list()[0]
        ?.members.map((member) => member.name)
        .sort(),
    ).toEqual(['First', 'Second']);
    expect(storage.repositories.agentMemberOrigins.list()).toHaveLength(2);
    expect(first.member.definition.runtime).toEqual(second.member.definition.runtime);
  } finally {
    await members.settle();
    await runtime.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
