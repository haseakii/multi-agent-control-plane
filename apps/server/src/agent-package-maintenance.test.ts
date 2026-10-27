import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { AgentControlService } from './agent-control.js';
import { AgentInstallationsService } from './agent-installations.js';
import { AgentCatalogService, OFFICIAL_CATALOG_URL } from './agent-catalog.js';
import type { NetworkSettingsService } from './network-settings.js';
import { buildServer } from './server.js';
import { AgentPackageMaintenance } from './agent-package-maintenance.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
const dispose: Array<() => void> = [];
afterEach(() => {
  for (const done of dispose.splice(0)) done();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acp-cleanup-'));
  let storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  dispose.push(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const observed = {
    readiness: {
      runtime: 'ready' as const,
      auth: 'not_reported' as const,
      observedAt: new Date().toISOString(),
    },
    authMethods: [],
  };
  const probe = vi.fn(async () => observed);
  let agents = new AgentControlService(storage, { probe, authenticate: probe });
  const installer = vi.fn();
  const options = () => ({
    storage,
    agents,
    catalog: new AgentCatalogService(),
    network: {} as NetworkSettingsService,
    root: join(root, 'agents'),
    releaseRoot: root,
    installPackage: installer,
  });
  let service = new AgentInstallationsService(options());
  const id = randomUUID(),
    at = new Date().toISOString();
  const directory = join(root, 'agents', 'fixture', '1.0.0', id, randomUUID());
  const put = (file: string, content = 'fixture') => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  const script = put(join(directory, 'program', 'worker.mjs'), 'process.exit(0);');
  const runtime = { type: 'acp-stdio' as const, command: process.execPath, args: [script] };
  const row = storage.repositories.agentInstallations.upsert({
    id,
    entryId: 'fixture',
    version: '1.0.0',
    planHash: 'a'.repeat(64),
    state: 'ready',
    message: 'Installed',
    directory,
    package: {
      origin: 'installation',
      runtime,
      source: {
        entryId: 'fixture',
        entryName: 'Fixture',
        catalogVersion: '1.0.0',
        catalogUrl: OFFICIAL_CATALOG_URL,
      },
    },
    createdAt: at,
    updatedAt: at,
  });
  const addMember = (name: string, enabled = false, entry = runtime) =>
    agents.create({
      id: name,
      name,
      enabled,
      runtime: entry,
      capabilities: [],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
  const apply = (action: 'history' | 'uninstall') => {
    const plan = service.maintenance.preview(id, { action });
    return service.maintenance.apply(id, { action, planHash: plan.planHash, confirmed: true });
  };
  return {
    root,
    id,
    at,
    directory,
    script,
    runtime,
    row,
    put,
    probe,
    observed,
    addMember,
    apply,
    installer,
    get service() {
      return service;
    },
    get storage() {
      return storage;
    },
    get agents() {
      return agents;
    },
    reopen() {
      storage.close();
      storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
      agents = new AgentControlService(storage, { probe, authenticate: probe });
      service = new AgentInstallationsService(options());
    },
  };
}

it('cleans old attempts and private download caches while preserving current/shared programs and user files', () => {
  const f = fixture();
  const old = f.put(join(dirname(f.directory), randomUUID(), 'partial.zip'));
  const reused = f.put(join(dirname(f.directory), randomUUID(), 'worker.mjs'));
  f.addMember('reused', false, { ...f.runtime, args: [reused] });
  const cache = f.put(join(f.directory, 'cache', 'download'));
  const archive = f.put(join(f.directory, 'package.zip'));
  const login = f.put(join(f.root, 'login', 'account.json'), 'preserve-login');
  const shared = f.put(join(f.root, 'runtimes', 'python', 'python.exe'));
  const unknown = f.put(join(dirname(f.directory), 'personal', 'notes'));
  f.addMember('current', true);
  f.apply('history');
  for (const file of [old, cache, archive]) expect(existsSync(file)).toBe(false);
  for (const file of [f.script, reused, shared, unknown]) expect(existsSync(file)).toBe(true);
  expect(readFileSync(login, 'utf8')).toBe('preserve-login');
  expect(f.service.list()[0]?.installed).toBe(true);
  expect(f.service.maintenance.preview(f.id, { action: 'history' }).canApply).toBe(false);
});

it('preserves download outputs referenced by another installation without members', () => {
  const f = fixture();
  const reused = f.put(join(f.directory, 'cache', 'worker.mjs'));
  f.storage.repositories.agentInstallations.upsert({
    ...f.row,
    id: randomUUID(),
    package: { ...f.row.package!, runtime: { ...f.runtime, args: [reused] } },
  });
  const archive = f.put(join(f.directory, 'package.zip'));
  f.apply('history');
  expect(existsSync(reused)).toBe(true);
  expect(existsSync(archive)).toBe(false);
});

it('blocks enabled/shared members, connection observations and live assignments, but retains disabled historical members on uninstall', async () => {
  const f = fixture();
  f.addMember('one', true);
  f.addMember('two', true);
  expect(f.service.maintenance.preview(f.id, { action: 'uninstall' }).blockers).toHaveLength(2);
  expect(() => f.apply('uninstall')).toThrow('停用');
  f.agents.update('one', { enabled: false });
  f.agents.update('two', { enabled: false });
  let release!: () => void;
  f.probe.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = () => done(f.observed);
      }),
  );
  const observation = f.agents.probe('one');
  expect(() => f.apply('uninstall')).toThrow('检查连接');
  release();
  await observation;
  const assignment = {
    id: 'assignment',
    taskId: 'historic-task',
    agentId: 'one',
    objective: 'fixture',
    state: 'running',
    attempt: 1,
    createdAt: f.at,
    updatedAt: f.at,
  };
  f.storage.repositories.assignments.upsert(assignment);
  expect(() => f.apply('uninstall')).toThrow('运行');
  f.storage.repositories.assignments.upsert({ ...assignment, state: 'completed' });
  const before = f.storage.repositories.agentDefinitions.list();
  f.apply('uninstall');
  expect(existsSync(f.directory)).toBe(false);
  expect(f.storage.repositories.agentDefinitions.list()).toEqual(before);
  expect(f.storage.repositories.assignments.get('assignment')?.state).toBe('completed');
  expect(f.service.list()[0]).toMatchObject({ state: 'uninstalled', installed: false });
  await expect(
    f.service.createMember(f.id, { requestId: randomUUID(), name: 'new' }),
  ).rejects.toThrow('未安装');
});

it('rejects a stale preview after files or member settings change', () => {
  const f = fixture();
  const plan = f.service.maintenance.preview(f.id, { action: 'uninstall' });
  f.put(join(f.directory, 'new-file'));
  expect(() =>
    f.service.maintenance.apply(f.id, {
      action: 'uninstall',
      planHash: plan.planHash,
      confirmed: true,
    }),
  ).toThrow('变化');
  expect(existsSync(f.script)).toBe(true);
  const next = f.service.maintenance.preview(f.id, { action: 'uninstall' });
  f.addMember('new-user', true);
  expect(() =>
    f.service.maintenance.apply(f.id, {
      action: 'uninstall',
      planHash: next.planHash,
      confirmed: true,
    }),
  ).toThrow('变化');
  expect(existsSync(f.script)).toBe(true);
});

it('rejects forged roots, directory junctions and internal links without touching their target', () => {
  const f = fixture();
  const external = f.put(join(f.root, 'external', 'keep'));
  f.storage.repositories.agentInstallations.upsert({ ...f.row, directory: dirname(external) });
  expect(() => f.apply('uninstall')).toThrow('不属于');
  f.storage.repositories.agentInstallations.upsert(f.row);
  const link = join(f.directory, 'linked');
  symlinkSync(dirname(external), link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => f.apply('uninstall')).toThrow('链接');
  expect(readFileSync(external, 'utf8')).toBe('fixture');
  expect(existsSync(f.script)).toBe(true);
});

it('preserves legacy installation records and recovers interrupted/failed removal across database reopen', () => {
  const f = fixture();
  f.reopen(); // Existing JSON installation payloads need no table migration.
  expect(f.service.list()[0]?.state).toBe('ready');
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  expect(() => f.apply('uninstall')).toThrow('未全部完成');
  expect(f.storage.repositories.agentInstallations.get(f.id)).toMatchObject({
    state: 'removal-failed',
  });
  expect(f.storage.repositories.agentInstallations.get(f.id)?.package).toBeUndefined();
  f.storage.repositories.agentInstallations.upsert({
    ...f.storage.repositories.agentInstallations.get(f.id)!,
    state: 'removing',
  });
  f.reopen();
  expect(f.service.list()[0]).toMatchObject({ state: 'removal-failed', installed: false });
  expect(f.service.discoverablePackages()).toEqual([]);
  f.apply('uninstall');
  f.reopen();
  expect(f.service.list()[0]).toMatchObject({ state: 'uninstalled', installed: false });
  expect(f.installer).not.toHaveBeenCalled();
});

it('validates public cleanup requests and does not accept a caller-supplied deletion path', async () => {
  const f = fixture(),
    app = buildServer({ agentInstallations: f.service });
  try {
    const url = `/api/agent-installations/${f.id}/maintenance`;
    const preview = await app.inject({
      method: 'POST',
      url: url + '-preview',
      payload: { action: 'history' },
    });
    expect(preview.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {
            action: 'uninstall',
            confirmed: true,
            planHash: preview.json().planHash,
            path: f.root,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(existsSync(f.script)).toBe(true);
  } finally {
    await app.close();
  }
});

it('blocks cleanup during installation and preserves another installation referencing the same files', () => {
  const f = fixture();
  const busy = new AgentPackageMaintenance({
    storage: f.storage,
    agents: f.agents,
    root: join(f.root, 'agents'),
    busy: () => true,
  });
  const plan = busy.preview(f.id, { action: 'uninstall' });
  expect(plan.canApply).toBe(false);
  expect(() =>
    busy.apply(f.id, { action: 'uninstall', confirmed: true, planHash: plan.planHash }),
  ).toThrow('正在安装');
  f.storage.repositories.agentInstallations.upsert({ ...f.row, id: randomUUID() });
  expect(() => f.apply('uninstall')).toThrow('其他安装记录');
  expect(existsSync(f.script)).toBe(true);
});

it('retains descendant member protections after its entry is edited and never traverses internal package links', () => {
  const f = fixture();
  f.storage.repositories.agentInstallations.upsert({ ...f.row, agentId: 'parent' });
  f.addMember('parent', false);
  f.addMember('child', true, { ...f.runtime, args: [f.put(join(f.root, 'other.mjs'))] });
  const requestId = randomUUID();
  f.storage.repositories.agentMemberOrigins.upsert({
    id: 'child',
    requestId,
    sourceAgentId: 'parent',
    requestHash: 'b'.repeat(64),
    runtimeFingerprint: 'c'.repeat(64),
    createdAt: f.at,
  });
  expect(() => f.apply('uninstall')).toThrow('child');
  f.agents.update('child', { enabled: false });
  symlinkSync(
    join(f.directory, 'program'),
    join(f.directory, 'internal-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  f.apply('uninstall');
  expect(existsSync(f.directory)).toBe(false);
  expect(existsSync(join(f.root, 'other.mjs'))).toBe(true);
});
