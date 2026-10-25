import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  chmodSync,
  copyFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDefinitionSchema } from '@control-plane/core';
import { openSqliteStorage } from '@control-plane/storage';
import { LocalRunner, type Runner, type ProcessHandle } from '@control-plane/runner';
import { LocalDirectoryBindings } from './local-directory-binding.js';
import { createControlPlaneRuntime, type ControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { readControlCenterSnapshot } from './control-center.js';

const roots: string[] = [],
  runtimes: ControlPlaneRuntime[] = [],
  apps: ReturnType<typeof buildServer>[] = [],
  storages: ReturnType<typeof openSqliteStorage>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const storage of storages.splice(0)) storage.close();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
function agent(cwd?: string) {
  return AgentDefinitionSchema.parse({
    id: 'binding-boss',
    name: 'Fixture Boss',
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: ['--version'],
      ...(cwd ? { cwd } : {}),
    },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: true },
    controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
  });
}
function setup(fakeProtocol = false) {
  const root = mkdtempSync(join(tmpdir(), 'cp-b0-'));
  roots.push(root);
  const source = join(root, '合成 source'),
    other = join(root, 'other'),
    privateRoot = join(root, 'private');
  mkdirSync(source);
  mkdirSync(other);
  mkdirSync(privateRoot);
  writeFileSync(join(source, 'source.txt'), 'synthetic source; never read by application');
  const storage = openSqliteStorage({ filename: ':memory:' });
  storages.push(storage);
  const base = new LocalRunner({ id: 'binding-fixture' });
  const spawn = vi.fn<Runner['spawn']>();
  const sessions: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let h: ProcessHandle;
  const runner = new Proxy(base, {
    get(target, key) {
      if (key === 'spawn') return spawn;
      if (fakeProtocol && key === 'transport')
        return () => ({
          readable: new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          writable: new WritableStream<Uint8Array>({
            write(chunk) {
              for (const line of new TextDecoder().decode(chunk).trim().split('\n')) {
                const m = JSON.parse(line);
                let result: unknown = {};
                if (m.method === 'initialize')
                  result = { protocolVersion: 1, agentCapabilities: {} };
                if (m.method === 'session/new') {
                  sessions.push(m.params.cwd);
                  result = { sessionId: 'fixture-only' };
                }
                if (m.method === 'session/prompt') {
                  controller!.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'session/update',
                        params: {
                          sessionId: 'fixture-only',
                          update: {
                            sessionUpdate: 'agent_message_chunk',
                            content: { type: 'text', text: 'synthetic result' },
                          },
                        },
                      }) + '\n',
                    ),
                  );
                  result = { stopReason: 'end_turn' };
                }
                if (m.id !== undefined)
                  controller!.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n',
                    ),
                  );
              }
            },
            close() {
              try {
                controller?.close();
              } catch {}
            },
          }),
        });
      if (fakeProtocol && (key === 'stop' || key === 'wait'))
        return async () => ({ ...h, state: 'exited' as const, exitCode: 0, signal: null });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Runner;
  if (fakeProtocol)
    spawn.mockImplementation(async () => {
      h = {
        id: 'fixture-process',
        runnerId: base.descriptor().id,
        pid: 0,
        startedAt: new Date().toISOString(),
      };
      return h;
    });
  else spawn.mockRejectedValue(Error('No Agent is allowed in metadata tests'));
  const inspection = {
    windowsMetadata: vi.fn((_paths: string[]) => ({ driveType: 'Fixed', reparsePoint: false })),
  };
  const runtime = createControlPlaneRuntime({
    storage,
    runner,
    artifactRoot: join(privateRoot, 'artifacts'),
    workspaceRoot: join(privateRoot, 'workspaces'),
    directoryInspection: inspection,
  });
  runtimes.push(runtime);
  runtime.setBridgeBaseUrl('http://127.0.0.1:49999');
  const app = buildServer({
    agentControl: runtime.agentControl,
    taskControl: runtime,
    controlCenter: () =>
      readControlCenterSnapshot(
        storage,
        (id) => runtime.agentControl.state(id),
        (id) => runtime.directoryBindings.confirmationVersion(id),
      ),
  });
  apps.push(app);
  async function bind(path = source, id = 'bound-project') {
    const preview = await app.inject({
      method: 'POST',
      url: '/api/directories/validate',
      payload: { path },
    });
    expect(preview.statusCode).toBe(200);
    const value = preview.json();
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        id,
        name: 'Bound synthetic project',
        executionWorkspaceMode: 'shared-directory',
        workspace: {
          kind: 'existing-local',
          validationId: value.validationId,
          confirmedPath: value.rootPath,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    return storage.repositories.workspaces.list().find((w) => w.projectId === id)!;
  }
  function ack(workspace: Awaited<ReturnType<typeof bind>>) {
    return {
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      version: runtime.directoryBindings.confirmationVersion(workspace.id),
    };
  }
  function boss(cwd?: string) {
    runtime.agentControl.create(agent(cwd));
    runtime.agentControl.selectBoss('bound-project', 'binding-boss');
  }
  return {
    root,
    source,
    other,
    privateRoot,
    storage,
    runtime,
    app,
    spawn,
    sessions,
    inspection,
    bind,
    ack,
    boss,
  };
}

describe.skipIf(process.platform !== 'win32')(
  'B0 local directory binding: synthetic metadata/API only',
  () => {
    it('keeps explicit MCP directory grants stable across restart while rejecting changed identities and shared execution', async () => {
      const s = setup(),
        workspace = await s.bind();
      const grant = {
        workspaceId: workspace.id,
        rootPath: workspace.rootPath,
        version: s.runtime.directoryBindings.persistentConfirmationVersion(workspace.id),
      };
      const restarted = new LocalDirectoryBindings(s.storage, [s.privateRoot], s.inspection);
      expect(restarted.persistentConfirmationVersion(workspace.id)).toBe(grant.version);
      expect(restarted.confirmationVersion(workspace.id)).not.toBe(
        s.runtime.directoryBindings.confirmationVersion(workspace.id),
      );
      expect(() =>
        s.runtime.resolveClientWorkspaceConfirmation(workspace.projectId, grant),
      ).toThrow('isolated');
      s.runtime.setWorkspaceMode(workspace.projectId, { mode: 'task-local' });
      expect(
        s.runtime.resolveClientWorkspaceConfirmation(workspace.projectId, grant)?.version,
      ).toBe(s.runtime.directoryBindings.confirmationVersion(workspace.id));
      expect(() =>
        s.runtime.resolveClientWorkspaceConfirmation(workspace.projectId, {
          ...grant,
          version: 'wrong',
        }),
      ).toThrow('stale');
      renameSync(s.source, s.source + '-original');
      mkdirSync(s.source);
      expect(() =>
        s.runtime.resolveClientWorkspaceConfirmation(workspace.projectId, grant),
      ).toThrow('changed');
    });
    it('coalesces in-flight preview identity checks and rejects a later replaced directory', async () => {
      const s = setup();
      const workspace = await s.bind();
      s.inspection.windowsMetadata.mockClear();
      await Promise.all([
        s.runtime.directoryBindings.validateIdentityAsync(workspace),
        s.runtime.directoryBindings.validateIdentityAsync(workspace),
      ]);
      expect(s.inspection.windowsMetadata).toHaveBeenCalledTimes(1);
      renameSync(s.source, s.source + '-original');
      mkdirSync(s.source);
      await expect(s.runtime.directoryBindings.validateIdentityAsync(workspace)).rejects.toThrow();
      expect(s.inspection.windowsMetadata).toHaveBeenCalledTimes(2);
      expect(s.spawn).not.toHaveBeenCalled();
    });
    it('validates and binds read-only source files without content scans, writes, Agent startup or new scopes', async () => {
      const s = setup();
      const file = join(s.source, 'source.txt');
      chmodSync(file, 0o444);
      const content = readFileSync(file, 'utf8');
      try {
        const workspace = await s.bind();
        expect(workspace.rootPath).toBe(realpathSync.native(s.source));
        expect(readdirSync(s.source)).toEqual(['source.txt']);
        expect(readFileSync(file, 'utf8')).toBe(content);
        expect(s.spawn).not.toHaveBeenCalled();
        expect(s.storage.repositories.tasks.list()).toEqual([]);
        expect(s.storage.repositories.agentDefinitions.list()).toEqual([]);
        expect(s.inspection.windowsMetadata.mock.calls.flatMap((c) => c[0])).not.toContain(file);
        expect(s.storage.repositories.workspaceDirectoryBindings.get(workspace.id)?.rootPath).toBe(
          realpathSync.native(s.source),
        );
      } finally {
        chmodSync(file, 0o666);
      }
    });
    it.each(['missing', 'file', 'relative', 'root', 'unc', 'device', 'ads'])(
      'rejects %s paths without mkdir or starting any Agent',
      async (kind) => {
        const s = setup();
        const inputs = {
          missing: join(s.root, 'not-created'),
          file: join(s.source, 'source.txt'),
          relative: 'relative-folder',
          root: resolve(s.source).slice(0, 3),
          unc: '\\\\invalid-host\\share',
          device: '\\\\?\\C:\\folder',
          ads: s.source + ':stream',
        };
        const before = readdirSync(s.root).sort();
        const r = await s.app.inject({
          method: 'POST',
          url: '/api/directories/validate',
          payload: { path: inputs[kind as keyof typeof inputs] },
        });
        expect(r.statusCode).toBe(400);
        expect(readdirSync(s.root).sort()).toEqual(before);
        expect(s.storage.repositories.projects.list()).toEqual([]);
        expect(s.spawn).not.toHaveBeenCalled();
      },
    );
    it('rejects case aliases, overlaps, junctions and protected private data; adjacent names remain usable', async () => {
      const s = setup();
      await s.bind();
      for (const path of [s.source.toUpperCase(), s.root]) {
        const r = await s.app.inject({
          method: 'POST',
          url: '/api/directories/validate',
          payload: { path },
        });
        expect([400, 409]).toContain(r.statusCode);
      }
      const link = join(s.root, 'junction');
      symlinkSync(s.source, link, 'junction');
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/directories/validate',
            payload: { path: link },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/directories/validate',
            payload: { path: s.privateRoot },
          })
        ).statusCode,
      ).toBe(400);
      mkdirSync(s.source + '-adjacent');
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/directories/validate',
            payload: { path: s.source + '-adjacent' },
          })
        ).statusCode,
      ).toBe(200);
    });
    it('rejects a synthetic user-home directory through its Windows short-name alias', () => {
      const s = setup();
      const previous = process.env.USERPROFILE;
      process.env.USERPROFILE = realpathSync.native(s.source);
      try {
        const service = new LocalDirectoryBindings(s.storage, [s.privateRoot], s.inspection);
        expect(() => service.preview({ path: s.source })).toThrow();
      } finally {
        if (previous === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previous;
      }
    });
    it('rejects redirected volumes/reparse metadata before inspecting any source contents', () => {
      const s = setup();
      for (const metadata of [
        { driveType: 'Network', reparsePoint: false },
        { driveType: 'Fixed', reparsePoint: true },
      ]) {
        const service = new LocalDirectoryBindings(s.storage, [], {
          windowsMetadata: () => metadata,
        });
        expect(() => service.preview({ path: s.source })).toThrow();
      }
      expect(s.spawn).not.toHaveBeenCalled();
    });
    it('requires the exact preview path and rejects expired/changed preview identity', async () => {
      const s = setup();
      const preview = s.runtime.previewExistingDirectory({ path: s.source });
      expect(() =>
        s.runtime.createProject({
          name: 'bad confirm',
          workspace: {
            kind: 'existing-local',
            validationId: preview.validationId,
            confirmedPath: s.other,
          },
        }),
      ).toThrow();
      const saved = join(s.root, 'original');
      renameSync(s.source, saved);
      mkdirSync(s.source);
      expect(() =>
        s.runtime.createProject({
          name: 'changed',
          workspace: {
            kind: 'existing-local',
            validationId: preview.validationId,
            confirmedPath: preview.rootPath,
          },
        }),
      ).toThrow(/identity/);
      const fresh = s.runtime.previewExistingDirectory({ path: s.source });
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 6 * 60_000);
      expect(() =>
        s.runtime.createProject({
          name: 'expired',
          workspace: {
            kind: 'existing-local',
            validationId: fresh.validationId,
            confirmedPath: fresh.rootPath,
          },
        }),
      ).toThrow(/again/);
      expect(s.storage.repositories.projects.list()).toEqual([]);
    });
    it('rolls back a failed create without modifying the external directory', async () => {
      const s = setup();
      const before = readFileSync(join(s.source, 'source.txt'), 'utf8');
      const p = s.runtime.previewExistingDirectory({ path: s.source });
      vi.spyOn(s.storage.repositories.events, 'append').mockImplementationOnce(() => {
        throw Error('Synthetic DB failure');
      });
      expect(() =>
        s.runtime.createProject({
          name: 'db-failure',
          workspace: {
            kind: 'existing-local',
            validationId: p.validationId,
            confirmedPath: p.rootPath,
          },
        }),
      ).toThrow('Synthetic DB');
      expect(s.storage.repositories.projects.list()).toEqual([]);
      expect(s.storage.repositories.workspaces.list()).toEqual([]);
      expect(s.storage.repositories.workspaceDirectoryBindings.list()).toEqual([]);
      expect(readdirSync(s.source)).toEqual(['source.txt']);
      expect(readFileSync(join(s.source, 'source.txt'), 'utf8')).toBe(before);
    });
    it('does not create a task for missing confirmation, wrong project/path version, disabled Agent or conflicting cwd', async () => {
      const s = setup();
      const w = await s.bind();
      s.boss();
      for (const workspaceConfirmation of [
        undefined,
        { ...s.ack(w), rootPath: s.other },
        { ...s.ack(w), workspaceId: 'other' },
        { ...s.ack(w), version: 'expired' },
      ]) {
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: '/api/projects/bound-project/goals',
              payload: {
                objective: 'Synthetic only',
                ...(workspaceConfirmation ? { workspaceConfirmation } : {}),
              },
            })
          ).statusCode,
        ).toBe(409);
      }
      s.runtime.agentControl.update('binding-boss', { enabled: false });
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/projects/bound-project/goals',
            payload: { objective: 'Synthetic only', workspaceConfirmation: s.ack(w) },
          })
        ).statusCode,
      ).toBe(400);
      s.runtime.agentControl.update('binding-boss', {
        enabled: true,
        runtime: { ...agent().runtime, cwd: s.other },
      });
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/projects/bound-project/goals',
            payload: { objective: 'Synthetic only', workspaceConfirmation: s.ack(w) },
          })
        ).statusCode,
      ).toBe(409);
      expect(s.storage.repositories.tasks.list()).toEqual([]);
      expect(s.spawn).not.toHaveBeenCalled();
    });
    it('revalidates after restart and rejects stale confirmations without auto execution', async () => {
      const s = setup();
      const w = await s.bind();
      s.boss();
      const previous = s.ack(w);
      await s.runtime.close();
      const next = createControlPlaneRuntime({
        storage: s.storage,
        runner: new LocalRunner({ id: 'next' }),
        artifactRoot: join(s.privateRoot, 'artifacts'),
        workspaceRoot: join(s.privateRoot, 'workspaces'),
        directoryInspection: s.inspection,
      });
      runtimes.push(next);
      next.setBridgeBaseUrl('http://127.0.0.1:49999');
      expect(next.directoryBindings.confirmationVersion(w.id)).not.toBe(previous.version);
      expect(() =>
        next.submitGoal('bound-project', {
          objective: 'Synthetic',
          workspaceConfirmation: previous,
        }),
      ).toThrow(/Confirm/);
      renameSync(s.source, s.other + '-moved');
      expect(() =>
        next.submitGoal('bound-project', {
          objective: 'Synthetic',
          workspaceConfirmation: {
            ...previous,
            version: next.directoryBindings.confirmationVersion(w.id),
          },
        }),
      ).toThrow(/Directory/);
      expect(s.storage.repositories.tasks.list()).toEqual([]);
    });
    it('uses identical canonical process and ACP session cwd with a deterministic in-memory ACP fixture', async () => {
      const s = setup(true);
      const w = await s.bind();
      s.boss(s.source.toUpperCase());
      const r = await s.app.inject({
        method: 'POST',
        url: '/api/projects/bound-project/goals',
        payload: { objective: 'Synthetic cwd fixture', workspaceConfirmation: s.ack(w) },
      });
      expect(r.statusCode).toBe(202);
      for (let i = 0; i < 100 && s.storage.repositories.tasks.list()[0]?.state !== 'completed'; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(s.storage.repositories.tasks.list()[0]?.state).toBe('completed');
      expect(s.spawn).toHaveBeenCalledTimes(1);
      expect(s.spawn.mock.calls[0]?.[0].cwd).toBe(w.rootPath);
      expect(s.sessions).toEqual([w.rootPath]);
      expect(readFileSync(join(s.source, 'source.txt'), 'utf8')).toBe(
        'synthetic source; never read by application',
      );
    });
    it('keeps Host/Origin protection and rejects unconfirmed project creation', async () => {
      const s = setup();
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/directories/validate',
            headers: { origin: 'https://attacker.test' },
            payload: { path: s.source },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/projects',
            payload: {
              name: 'unconfirmed',
              workspace: {
                kind: 'existing-local',
                validationId: '00000000-0000-4000-8000-000000000000',
                confirmedPath: s.source,
              },
            },
          })
        ).statusCode,
      ).toBe(409);
      expect(s.storage.repositories.tasks.list()).toEqual([]);
    });
    it('runs the actual Windows fixed-volume/reparse metadata inspection on a synthetic path', () => {
      const s = setup();
      const service = new LocalDirectoryBindings(s.storage, [s.privateRoot]);
      expect(service.preview({ path: s.source }).rootPath).toBe(realpathSync.native(s.source));
    }, 15000);
  },
);

it('migrates the five-migration baseline without rewriting existing workspace payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-b0-migration-'));
  roots.push(root);
  const migrations = join(root, 'old-migrations');
  mkdirSync(join(migrations, 'meta'), { recursive: true });
  const journal = JSON.parse(
    readFileSync(
      new URL('../../../packages/storage/drizzle/meta/_journal.json', import.meta.url),
      'utf8',
    ),
  );
  journal.entries = journal.entries.slice(0, 5);
  writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    copyFileSync(
      new URL('../../../packages/storage/drizzle/' + entry.tag + '.sql', import.meta.url),
      join(migrations, entry.tag + '.sql'),
    );
  const filename = join(root, 'old.sqlite');
  const old = openSqliteStorage({ filename, migrationsFolder: migrations });
  old.repositories.projects.upsert({
    id: 'legacy',
    name: 'legacy',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  });
  old.repositories.workspaces.upsert({
    id: 'legacy-workspace',
    projectId: 'legacy',
    provider: 'local-directory',
    rootPath: join(root, 'legacy'),
    access: 'read-write',
  });
  const before = old.sqlite.prepare('SELECT payload FROM workspaces').get();
  old.close();
  const migrated = openSqliteStorage({ filename });
  try {
    expect(migrated.sqlite.prepare('SELECT payload FROM workspaces').get()).toEqual(before);
    expect(migrated.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual(
      { n: 21 },
    );
    expect(migrated.repositories.workspaceDirectoryBindings.list()).toEqual([]);
  } finally {
    migrated.close();
  }
});
