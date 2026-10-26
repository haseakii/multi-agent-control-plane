import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createClientHttpTransport, clientToolDefinitions } from '@control-plane/fleet-mcp';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { ExternalClientsService } from './external-clients.js';
import { buildServer } from './server.js';
import { codexCliPath, installCodexClient } from './external-client-install.js';

it('creates project-scoped reusable configs, shares records, and revokes each grant immediately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'external-client-')),
    filename = join(root, 'state.sqlite');
  let storage = openSqliteStorage({ filename });
  const runtime = createControlPlaneRuntime({
    storage,
    artifactRoot: join(root, 'artifacts'),
    workspaceRoot: join(root, 'workspaces'),
  });
  const installationFile = join(root, 'installation.json');
  writeFileSync(
    installationFile,
    JSON.stringify({ version: 1, runtimeFile: process.execPath, current: { releaseDir: root } }),
  );
  const options = {
    storage,
    runtime,
    installationFile,
    baseUrl: 'http://127.0.0.1:8057',
    readLegacy: () => ({ version: 1, clients: [] }),
  };
  const service = new ExternalClientsService(options);
  let runtimeClosed = false;
  const app = buildServer({
    taskControl: runtime,
    externalClients: service,
    clientGateway: { storage, runtime, readAccess: service.readAccess },
  });
  const call = (token: string, toolName: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + token },
      payload: { toolName, input },
    });
  try {
    expect(
      (await app.inject({ method: 'GET', url: '/api/external-clients' })).json(),
    ).toMatchObject({ projects: [], unavailableProjects: [] });
    runtime.createProject({ id: 'p', name: 'Shared' });
    runtime.setWorkspaceMode('p', { mode: 'task-local' });
    const workspaceConfig = storage.repositories.projectWorkspaceConfigs.get('p')!;
    storage.repositories.projectWorkspaceConfigs.delete('p');
    expect(
      (await app.inject({ method: 'GET', url: '/api/external-clients' })).json(),
    ).toMatchObject({ projects: [], unavailableProjects: [{ id: 'p', name: 'Shared' }] });
    expect(() =>
      service.create({
        requestId: randomUUID(),
        name: 'No implicit grant',
        target: 'generic',
        profile: 'read',
        projectId: 'p',
      }),
    ).toThrow('目录不可用');
    storage.repositories.projectWorkspaceConfigs.upsert(workspaceConfig);
    runtime.createProject({ id: 'other', name: 'Private' });
    runtime.setWorkspaceMode('other', { mode: 'task-local' });
    const input = {
      requestId: randomUUID(),
      name: 'Reader',
      target: 'cursor',
      profile: 'read',
      projectId: 'p',
    };
    const first = (
      await app.inject({ method: 'POST', url: '/api/external-clients', payload: input })
    ).json();
    expect(first.config).toContain('launcher');
    expect(first.config).toContain('connections');
    const config = JSON.parse(first.config),
      server = Object.values(config.mcpServers)[0] as { command: string; args: string[] };
    const connection = JSON.parse(readFileSync(server.args.at(-1)!, 'utf8'));
    expect(first.config).not.toContain(connection.token);
    expect(first.config).not.toContain('tokenSha256');
    expect(
      JSON.parse(
        Buffer.from(new URL(first.installUrl).searchParams.get('config')!, 'base64').toString(),
      ),
    ).toEqual(server);
    expect(service.create(input).id).toBe(first.id);
    expect(() => service.create({ ...input, name: 'Changed' })).toThrow('请求内容已改变');
    const second = service.create({
      ...input,
      requestId: randomUUID(),
      target: 'vscode',
      profile: 'collaborate',
      name: 'Writer',
    });
    expect(JSON.parse(decodeURIComponent(second.installUrl!.split('?')[1]!))).toMatchObject({
      name: second.name,
      command: process.execPath,
    });
    const secondConnection = JSON.parse(readFileSync(second.server.args.at(-1)!, 'utf8'));
    expect(
      (await call(connection.token, 'collaboration_list_projects', {}))
        .json()
        .result.projects.map((p: { id: string }) => p.id),
    ).toEqual(['p']);
    expect(
      (await call(connection.token, 'collaboration_list_tasks', { projectId: 'other' })).statusCode,
    ).toBe(403);
    expect(
      (
        await call(connection.token, 'collaboration_submit_task', {
          projectId: 'p',
          agentId: 'none',
          objective: 'write',
          idempotencyKey: 'once',
        })
      ).statusCode,
    ).toBe(403);
    expect(service.list().find((c) => c.id === first.id)?.lastUsedAt).toBeDefined();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/external-clients/' + first.id + '/revoke',
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(connection.token, 'collaboration_list_projects', {})).statusCode).toBe(401);
    expect((await call(secondConnection.token, 'collaboration_list_projects', {})).statusCode).toBe(
      200,
    );
    expect(storage.repositories.projects.list()).toHaveLength(2);
    await runtime.close();
    runtimeClosed = true;
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.externalClients.get(first.id)?.access.enabled).toBe(false);
    expect(storage.repositories.externalClients.get(second.id)?.access.enabled).toBe(true);
    expect(
      storage.repositories.events.listByProject('p').some((e) => e.type === 'client.tool.called'),
    ).toBe(true);
  } finally {
    if (!runtimeClosed) await runtime.close();
    await app.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('migrates an existing twenty-migration database without changing history or input bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'external-migration-')),
    old = join(root, 'old'),
    filename = join(root, 'state.sqlite');
  mkdirSync(join(old, 'meta'), { recursive: true });
  const directory = resolve('packages/storage/drizzle');
  const journal = JSON.parse(readFileSync(join(directory, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 20);
  writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
  for (const row of journal.entries)
    copyFileSync(join(directory, row.tag + '.sql'), join(old, row.tag + '.sql'));
  let storage = openSqliteStorage({ filename, migrationsFolder: old });
  try {
    storage.repositories.projects.upsert({
      id: 'p',
      name: 'Keep',
      createdAt: '2026-10-25T00:00:00Z',
      updatedAt: '2026-10-25T00:00:00Z',
    });
    storage.sqlite
      .prepare('INSERT INTO input_attachments(id,payload,content) VALUES(?,?,?)')
      .run('keep', '{"preserved":true}', Buffer.from([0, 1, 254, 255]));
    const before = storage.sqlite.prepare('SELECT * FROM input_attachments').all();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projects.get('p')?.name).toBe('Keep');
    expect(storage.sqlite.prepare('SELECT * FROM input_attachments').all()).toEqual(before);
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 22,
    });
    expect(storage.repositories.externalClients.list()).toEqual([]);
    expect(storage.repositories.agentInstallations.list()).toEqual([]);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(!codexCliPath())(
  'installs through the real existing Codex CLI in a private home, preserving Windows and other entries',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-native-config-'));
    try {
      writeFileSync(
        join(root, 'config.toml'),
        'model = "gpt-5"\n[windows]\nsandbox = "unelevated"\n[mcp_servers.existing]\ncommand = "keep-me"\nargs = []\n',
      );
      const server = {
        command: process.execPath,
        args: ['C:/test/entry.mjs', 'mcp', '--connection', 'C:/test/connection.json'],
      };
      await installCodexClient('collaboration_ab123456', server, { home: root });
      await installCodexClient('collaboration_ab123456', server, { home: root });
      const text = readFileSync(join(root, 'config.toml'), 'utf8');
      expect(text).toMatch(/\[windows\]\r?\nsandbox = "unelevated"/);
      expect(text).toContain('[mcp_servers.existing]');
      expect(text).toContain('command = "keep-me"');
      expect(text.match(/\[mcp_servers.collaboration_ab123456\]/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
it('updates multiple project grants without replacing a client connection and filters its live capabilities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'multi-project-client-')),
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    artifactRoot: join(root, 'artifacts'),
    workspaceRoot: join(root, 'workspaces'),
  });
  const installationFile = join(root, 'installation.json');
  writeFileSync(
    installationFile,
    JSON.stringify({ version: 1, runtimeFile: process.execPath, current: { releaseDir: root } }),
  );
  let legacy: unknown = { version: 1, clients: [] };
  const options = {
    storage,
    runtime,
    installationFile,
    baseUrl: 'http://127.0.0.1:0',
    readLegacy: () => legacy,
  };
  const service = new ExternalClientsService(options),
    app = buildServer({
      taskControl: runtime,
      externalClients: service,
      clientGateway: { storage, runtime, readAccess: service.readAccess },
    });
  try {
    options.baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const id of ['p', 'q', 'private']) {
      runtime.createProject({ id, name: id });
      runtime.setWorkspaceMode(id, { mode: 'task-local' });
    }
    const generated = service.create({
      requestId: randomUUID(),
      name: 'One connection',
      target: 'generic',
      profile: 'read',
      projects: [{ projectId: 'p' }],
    });
    const file = generated.server.args.at(-1)!,
      bytes = readFileSync(file, 'utf8'),
      token = JSON.parse(bytes).token,
      transport = createClientHttpTransport(options.baseUrl, token);
    const update = {
      requestId: randomUUID(),
      expectedRevision: 1,
      profile: 'read',
      projects: [{ projectId: 'p' }, { projectId: 'q' }],
    };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/external-clients/' + generated.id + '/grants',
          payload: update,
        })
      ).json(),
    ).toMatchObject({ revision: 2 });
    expect(service.updateGrants(generated.id, update).revision).toBe(2);
    expect((await transport.invoke('collaboration_list_projects', {})).projects).toHaveLength(2);
    expect(await transport.getTools!()).toEqual(
      clientToolDefinitions.filter((tool) => tool.readOnly).map((tool) => tool.name),
    );
    await expect(
      transport.invoke('collaboration_list_tasks', { projectId: 'private' }),
    ).rejects.toThrow();
    service.updateGrants(generated.id, {
      requestId: randomUUID(),
      expectedRevision: 2,
      profile: 'collaborate',
      projects: update.projects,
    });
    expect(await transport.getTools!()).toContain('collaboration_submit_task');
    service.updateGrants(generated.id, {
      requestId: randomUUID(),
      expectedRevision: 3,
      profile: 'read',
      projects: [{ projectId: 'p' }],
    });
    await expect(
      transport.invoke('collaboration_list_tasks', { projectId: 'q' }),
    ).rejects.toThrow();
    await expect(
      transport.invoke('collaboration_submit_task', {
        projectId: 'p',
        agentId: 'none',
        objective: 'no execution',
        idempotencyKey: 'denied',
      }),
    ).rejects.toThrow();
    expect(() =>
      service.updateGrants(generated.id, { ...update, requestId: randomUUID() }),
    ).toThrow('授权已在其他位置更新');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(service.configuration(generated.id).config).toBe(generated.config);
    expect(storage.repositories.externalClients.list()).toHaveLength(1);
    const legacyToken = 'b'.repeat(64);
    legacy = {
      version: 1,
      clients: [
        {
          id: 'existing-native-client',
          name: 'Existing client',
          enabled: true,
          tokenSha256: createHash('sha256').update(legacyToken).digest('hex'),
          projects: [{ projectId: 'p' }],
          tools: clientToolDefinitions.map((tool) => tool.name),
        },
      ],
    };
    service.updateGrants('existing-native-client', {
      requestId: randomUUID(),
      expectedRevision: 0,
      profile: 'read',
      projects: update.projects,
    });
    expect(
      (
        await createClientHttpTransport(options.baseUrl, legacyToken).invoke(
          'collaboration_list_projects',
          {},
        )
      ).projects,
    ).toHaveLength(2);
    expect(
      service.readAccess().clients.filter((client) => client.id === 'existing-native-client'),
    ).toHaveLength(1);
    service.revoke(generated.id);
    await expect(transport.getTools!()).rejects.toThrow('revoked');
  } finally {
    await runtime.close();
    await app.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('counts active clients separately from revoked history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'active-client-quota-')),
    storage = openSqliteStorage({ filename: ':memory:' });
  const runtime = createControlPlaneRuntime({
    storage,
    artifactRoot: join(root, 'artifacts'),
    workspaceRoot: join(root, 'workspaces'),
  });
  const installationFile = join(root, 'installation.json');
  writeFileSync(
    installationFile,
    JSON.stringify({ version: 1, runtimeFile: process.execPath, current: { releaseDir: root } }),
  );
  const disabled = Array.from({ length: 64 }, (_, i) => ({
    id: 'old-' + i,
    name: 'Revoked',
    enabled: false,
    tokenSha256: 'a'.repeat(64),
    projects: [{ projectId: 'p' }],
    tools: ['collaboration_list_projects'],
  }));
  const service = new ExternalClientsService({
    storage,
    runtime,
    installationFile,
    baseUrl: 'http://127.0.0.1:8057',
    readLegacy: () => ({ version: 1, clients: disabled }),
  });
  try {
    runtime.createProject({ id: 'p', name: 'Quota' });
    runtime.setWorkspaceMode('p', { mode: 'task-local' });
    const create = () =>
      service.create({
        requestId: randomUUID(),
        name: 'New active',
        target: 'generic',
        profile: 'read',
        projects: [{ projectId: 'p' }],
      });
    const first = create();
    expect(service.list()).toHaveLength(65);
    expect(service.readAccess().clients).toHaveLength(1);
    const row = storage.repositories.externalClients.get(first.id)!;
    for (let i = 0; i < 63; i++) {
      const uuid = randomUUID(),
        id = 'client-' + uuid;
      storage.repositories.externalClients.upsert({
        ...row,
        id,
        requestId: uuid,
        access: { ...row.access, id },
      });
    }
    expect(() => create()).toThrow('上限');
    service.revoke(first.id);
    expect(create().id).not.toBe(first.id);
    expect(service.readAccess().clients).toHaveLength(64);
    expect(service.list().some((client) => client.id === first.id && !client.enabled)).toBe(true);
  } finally {
    await runtime.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
