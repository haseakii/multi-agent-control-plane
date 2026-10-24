import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openSqliteStorage, createConsistentSqliteSnapshot } from '@control-plane/storage';
import { LocalRunner } from '@control-plane/runner';
import { TaskEngine } from '@control-plane/task-engine';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { readControlCenterSnapshot } from './control-center.js';
import { buildServer } from './server.js';

const encoded = Buffer.from('synthetic-user:R3_SYNTHETIC_CANARY').toString('base64');
const base = {
  projectId: 'synthetic-project',
  action: 'acp.tool',
  boundary: 'acp-permission',
  resource: {},
  enforcementMode: 'cooperative',
  state: 'expired',
  requestedAt: '2026-10-21T00:00:00Z',
};
function insertUnsafe(
  storage: ReturnType<typeof openSqliteStorage>,
  id: string,
  state = 'pending',
  links: Record<string, string> = {},
) {
  const payload = JSON.stringify({
    ...base,
    id,
    state,
    ...links,
    resource: { description: 'Authorization: Basic ' + encoded },
  });
  storage.sqlite
    .prepare('INSERT INTO approvals(id,project_id,boundary,state,payload) VALUES(?,?,?,?,?)')
    .run(id, base.projectId, base.boundary, state, payload);
  return createHash('sha256').update(payload).digest('hex');
}
function unchanged(storage: ReturnType<typeof openSqliteStorage>, id: string, hash: string) {
  const row = storage.sqlite.prepare('SELECT payload FROM approvals WHERE id=?').get(id) as {
    payload: string;
  };
  return createHash('sha256').update(row.payload).digest('hex') === hash;
}
function record(name: string, facts: unknown) {
  const directory = process.env.CONTROL_PLANE_ISOLATION_EVIDENCE;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name + '.json'), JSON.stringify(facts, null, 2));
  }
}

describe('approval isolation availability boundary', () => {
  it('keeps mixed approval and control-center API queries usable and bad records inoperable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-isolation-api-'));
    const storage = openSqliteStorage({ filename: join(root, 'state.sqlite') }),
      logs: string[] = [];
    const runtime = createControlPlaneRuntime({
      storage,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
    const app = buildServer({
      fastify: {
        logger: {
          level: 'info',
          stream: {
            write: (chunk) => {
              logs.push(String(chunk));
            },
          },
        },
      },
      taskControl: runtime,
      controlCenter: () => readControlCenterSnapshot(storage),
    });
    const before = insertUnsafe(storage, 'unsafe-pending');
    insertUnsafe(storage, 'unsafe-expired', 'expired');
    storage.repositories.approvals.upsert({ ...base, id: 'safe-expired' });
    try {
      const approvals = await app.inject({ method: 'GET', url: '/api/approvals' }),
        center = await app.inject({ method: 'GET', url: '/api/control-center' });
      record('list', {
        syntheticOnly: true,
        approvalsStatus: approvals.statusCode,
        controlCenterStatus: center.statusCode,
        secretInHttp: [approvals.body, center.body].some((x) => x.includes(encoded)),
        secretInLogs: logs.some((x) => x.includes(encoded)),
        payloadUnchanged: unchanged(storage, 'unsafe-pending', before),
      });
      expect(approvals.statusCode).toBe(200);
      expect(center.statusCode).toBe(200);
      expect(approvals.json().map((x: { id: string }) => x.id)).toEqual(['safe-expired']);
      expect(approvals.headers['x-control-plane-approval-isolation-count']).toBe('2');
      expect(center.json().approvalReadDiagnostics).toEqual({
        code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED',
        count: 2,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/approvals/unsafe-pending/approve',
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/approvals/unsafe-pending/reject',
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      storage.repositories.approvals.upsert({
        ...base,
        id: 'safe-new',
        action: 'workspace.read',
        boundary: 'fleet-policy',
        state: 'pending',
      });
      expect(
        (await app.inject({ method: 'POST', url: '/api/approvals/safe-new/approve', payload: {} }))
          .statusCode,
      ).toBe(200);
      expect(storage.repositories.approvals.get('safe-new')?.state).toBe('approved');
      expect(logs.length > 0).toBe(true);
      expect([approvals.body, center.body, ...logs].some((x) => x.includes(encoded))).toBe(false);
      expect(unchanged(storage, 'unsafe-pending', before)).toBe(true);
    } finally {
      await runtime.close();
      await app.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('cold-starts from a real SQLite file without modifying or replaying isolated records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-isolation-start-')),
      filename = join(root, 'state.sqlite');
    let runtime: ReturnType<typeof createControlPlaneRuntime> | undefined;
    let storage = openSqliteStorage({ filename });
    storage.repositories.projects.upsert({
      id: base.projectId,
      name: 'Synthetic interrupted project',
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
    });
    storage.repositories.workspaces.upsert({
      id: 'synthetic-workspace',
      projectId: base.projectId,
      provider: 'local-directory',
      rootPath: join(root, 'workspaces'),
      access: 'read-write',
    });
    storage.repositories.agentDefinitions.upsert({
      id: 'synthetic-agent',
      name: 'Local fixture only',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../fixtures/permission-boundary-agent.mjs', import.meta.url)),
        ],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    });
    const engine = new TaskEngine(storage.repositories);
    engine.createTask({
      id: 'interrupted-task',
      projectId: base.projectId,
      title: 'Synthetic interrupted task',
      objective: 'full',
      state: 'ready',
    });
    engine.createAssignment({
      id: 'interrupted-assignment',
      taskId: 'interrupted-task',
      agentId: 'synthetic-agent',
      objective: 'full',
    });
    const interrupted = engine.createAttempt('interrupted-assignment');
    engine.startAttempt(interrupted.id);
    const before = insertUnsafe(storage, 'unsafe-pending', 'pending', {
      taskId: 'interrupted-task',
      assignmentId: 'interrupted-assignment',
      requesterAgentId: 'synthetic-agent',
    });
    insertUnsafe(storage, 'unsafe-expired', 'expired');
    storage.repositories.approvals.upsert({ ...base, id: 'safe-expired' });
    storage.repositories.approvals.upsert({
      ...base,
      id: 'safe-pending',
      action: 'workspace.read',
      boundary: 'fleet-policy',
      state: 'pending',
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    const runner = new LocalRunner();
    let spawns = 0;
    const spawn = runner.spawn.bind(runner);
    runner.spawn = async (spec) => {
      spawns++;
      return spawn(spec);
    };
    let startupFailed = false;
    try {
      try {
        runtime = createControlPlaneRuntime({
          storage,
          runner,
          workspaceRoot: join(root, 'workspaces'),
          artifactRoot: join(root, 'artifacts'),
        });
      } catch {
        startupFailed = true;
      }
      record('startup', {
        syntheticOnly: true,
        startupFailed,
        payloadUnchanged: unchanged(storage, 'unsafe-pending', before),
        attempts: storage.repositories.executionAttempts.list().length,
      });
      expect(startupFailed).toBe(false);
      expect(unchanged(storage, 'unsafe-pending', before)).toBe(true);
      expect(runtime!.listApprovals().map((x) => x.id)).toEqual(['safe-expired', 'safe-pending']);
      expect(storage.repositories.approvals.get('safe-pending')?.state).toBe('expired');
      expect(runtime!.readApprovals().diagnostics).toEqual({
        code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED',
        count: 2,
      });
      expect(storage.repositories.executionAttempts.list()).toHaveLength(1);
      expect(storage.repositories.executionAttempts.get(interrupted.id)?.state).toBe('interrupted');
      expect(runtime!.getTask('interrupted-task').state).toBe('waiting');
      expect(spawns).toBe(0);
      await runtime!.close();
      runtime = undefined;
      const snapshot = join(root, 'snapshot.sqlite');
      await createConsistentSqliteSnapshot(filename, snapshot);
      const restored = openSqliteStorage({ filename: snapshot });
      try {
        const recovered = createControlPlaneRuntime({
          storage: restored,
          runner,
          workspaceRoot: join(root, 'restored-workspaces'),
          artifactRoot: join(root, 'restored-artifacts'),
        });
        try {
          expect(recovered.readApprovals().diagnostics.count).toBe(2);
          expect(unchanged(restored, 'unsafe-pending', before)).toBe(true);
          expect(restored.repositories.executionAttempts.list()).toHaveLength(1);
          expect(restored.repositories.executionAttempts.get(interrupted.id)?.state).toBe(
            'interrupted',
          );
          expect(spawns).toBe(0);
          const publicValue = JSON.stringify(readControlCenterSnapshot(restored));
          expect(publicValue.includes(encoded)).toBe(false);
          record('restored', {
            syntheticOnly: true,
            coldStartSucceeded: true,
            restoredSucceeded: true,
            payloadUnchanged: unchanged(restored, 'unsafe-pending', before),
            spawnCount: spawns,
            diagnostics: recovered.readApprovals().diagnostics,
            secretInPublicObservation: publicValue.includes(encoded),
          });
        } finally {
          await recovered.close();
        }
      } finally {
        restored.close();
      }
    } finally {
      if (runtime) await runtime.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['invalid-json', 'invalid-schema', 'inspection-limit', 'unknown'])(
    'does not report healthy isolation for %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'approval-isolation-hard-error-')),
        logs: string[] = [];
      const storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
      const runtime = createControlPlaneRuntime({
        storage,
        workspaceRoot: join(root, 'workspaces'),
        artifactRoot: join(root, 'artifacts'),
      });
      const app = buildServer({
        fastify: {
          logger: {
            level: 'info',
            stream: {
              write: (chunk) => {
                logs.push(String(chunk));
              },
            },
          },
        },
        taskControl: runtime,
        controlCenter: () => readControlCenterSnapshot(storage),
      });
      let fault: ReturnType<typeof vi.spyOn> | undefined;
      try {
        if (mode === 'unknown')
          fault = vi
            .spyOn(storage.repositories.approvals, 'listWithDiagnostics')
            .mockImplementation(() => {
              throw new Error('Synthetic unknown storage fault');
            });
        else {
          let resource: unknown = {};
          for (let i = 0; i < 20; i++) resource = { child: resource };
          const payload =
            mode === 'invalid-json'
              ? 'invalid JSON ' + encoded
              : mode === 'invalid-schema'
                ? JSON.stringify({ id: 'broken', unexpected: encoded })
                : JSON.stringify({ ...base, id: 'broken', resource });
          storage.sqlite
            .prepare('INSERT INTO approvals(id,project_id,state,payload) VALUES(?,?,?,?)')
            .run('broken', base.projectId, base.state, payload);
        }
        for (const url of ['/api/approvals', '/api/control-center']) {
          const response = await app.inject({ method: 'GET', url });
          expect(response.statusCode).toBe(500);
          expect(response.body.includes(encoded)).toBe(false);
          expect(response.headers['x-control-plane-approval-isolation-count']).toBeUndefined();
        }
        expect(logs.some((x) => x.includes(encoded))).toBe(false);
        if (mode !== 'unknown')
          expect(() =>
            createControlPlaneRuntime({
              storage,
              workspaceRoot: join(root, 'cold-workspaces'),
              artifactRoot: join(root, 'cold-artifacts'),
            }),
          ).toThrow();
      } finally {
        fault?.mockRestore();
        if (mode !== 'unknown')
          storage.sqlite.prepare('DELETE FROM approvals WHERE id=?').run('broken');
        await runtime.close();
        await app.close();
        storage.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
