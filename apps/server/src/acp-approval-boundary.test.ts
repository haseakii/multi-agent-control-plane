import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDefinitionSchema, ApprovalSchema } from '@control-plane/core';
import { openSqliteStorage, createConsistentSqliteSnapshot } from '@control-plane/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { permissionIdentity } from '@control-plane/acp-runtime';
import { LocalRunner, type ProcessHandle } from '@control-plane/runner';
import { buildServer } from './server.js';
import { readControlCenterSnapshot } from './control-center.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
async function fixture(permissionTtlMs?: number, nativeEdit = false) {
  const directory = mkdtempSync(join(tmpdir(), 'acp-boundary-'));
  const storage = openSqliteStorage({ filename: join(directory, 'state.sqlite') });
  const runner = new LocalRunner(),
    handles: ProcessHandle[] = [];
  const spawn = runner.spawn.bind(runner);
  runner.spawn = async (spec) => {
    const handle = await spawn(spec);
    handles.push(handle);
    return handle;
  };
  const testName = expect.getState().currentTestName;
  const runtime = createControlPlaneRuntime({
    storage,
    runner,
    workspaceRoot: join(directory, 'workspaces'),
    artifactRoot: join(directory, 'artifacts'),
    ...(permissionTtlMs ? { permissionTtlMs } : {}),
  });
  const app = buildServer({
    controlCenter: () =>
      readControlCenterSnapshot(storage, undefined, undefined, (approval) =>
        runtime.approvalDecisionEligibility(approval),
      ),
    agentControl: runtime.agentControl,
    taskControl: runtime,
    fleetGateway: runtime.fleetGateway,
  });
  disposers.push(async () => {
    await runtime.close();
    if (process.env.CONTROL_PLANE_STAGE1_EVIDENCE) {
      const destination = process.env.CONTROL_PLANE_STAGE1_EVIDENCE;
      mkdirSync(destination, { recursive: true });
      const receipts = storage.repositories.workspaces.list().flatMap((workspace) => {
        const file = join(workspace.rootPath, 'permission-ack.jsonl');
        return existsSync(file)
          ? readFileSync(file, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : [];
      });
      writeFileSync(
        join(destination, randomUUID() + '.json'),
        JSON.stringify(
          {
            testName,
            realModels: 0,
            approvals: storage.repositories.approvals.list(),
            approvalReadDiagnostics:
              storage.repositories.approvals.listWithDiagnostics().diagnostics,
            attempts: storage.repositories.executionAttempts.list(),
            receipts,
            processStatus: handles.map((handle) => runner.status(handle)),
          },
          null,
          2,
        ),
      );
    }
    await app.close();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
  runtime.createProject({ id: 'project', name: 'Synthetic permission boundary' });
  runtime.agentControl.create(
    AgentDefinitionSchema.parse({
      id: 'fixture',
      name: 'Fixture',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../fixtures/permission-boundary-agent.mjs', import.meta.url)),
          ...(nativeEdit ? ['--native-edit'] : []),
        ],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    }),
  );
  runtime.agentControl.selectBoss('project', 'fixture');
  return { app, storage, runtime, directory };
}

function executionDirectory(storage: ReturnType<typeof openSqliteStorage>) {
  const binding = storage.repositories.assignmentWorkspaces.list()[0]!;
  return storage.repositories.workspaces.get(binding.workspaceId)!.rootPath;
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, objective = 'full') {
  const submitted = f.runtime.submitGoal('project', { objective });
  await expect.poll(() => f.runtime.listApprovals('pending').length, { timeout: 5000 }).toBe(1);
  return { submitted, approval: f.runtime.listApprovals('pending')[0]! };
}
const decide = (f: Awaited<ReturnType<typeof fixture>>, id: string, action = 'approve') =>
  f.app.inject({ method: 'POST', url: `/api/approvals/${id}/${action}`, payload: {} });

describe('durable ACP approval ownership', () => {
  it('automatically approves a complete large native edit and stores bounded fingerprints', async () => {
    const f = await fixture(undefined, true);
    const { id, revision, updatedAt, ...rules } = f.runtime.getProjectPolicy('project');
    f.runtime.setProjectPolicy('project', {
      ...rules,
      expectedRevision: revision,
      agentPermissions: { workspaceFiles: 'auto', commands: 'ask', outsideWorkspace: 'ask' },
    });
    const submitted = f.runtime.submitGoal('project', { objective: 'native-large' });
    await expect
      .poll(() => f.runtime.getTask(submitted.task.id).state, { timeout: 6000 })
      .toBe('completed');
    const approval = f.storage.repositories.approvals
      .list()
      .find((a) => a.taskId === submitted.task.id)!;
    expect(approval).toMatchObject({
      state: 'approved',
      decisionActor: 'project-policy:1',
      acp: { review: { status: 'complete', action: 'file.write' } },
    });
    expect(JSON.stringify(approval.acp?.review)).toContain('file-content bytes=');
    expect(readFileSync(join(executionDirectory(f.storage), 'auto-policy.txt'), 'utf8')).toBe(
      'const after = 2;\n'.repeat(1600),
    );
  });
  it('audits operator-configured automatic file decisions and applies revised denial on the next request', async () => {
    const f = await fixture(undefined, true);
    const save = (workspaceFiles: 'auto' | 'deny') => {
      const { id, revision, updatedAt, ...rules } = f.runtime.getProjectPolicy('project');
      return f.runtime.setProjectPolicy('project', {
        ...rules,
        expectedRevision: revision,
        agentPermissions: { ...rules.agentPermissions, workspaceFiles },
      });
    };
    save('auto');
    const first = f.runtime.submitGoal('project', { objective: 'native-auto' });
    await expect
      .poll(() => f.runtime.getTask(first.task.id).state, { timeout: 6000 })
      .toBe('completed');
    const approval = f.storage.repositories.approvals
      .list()
      .find((a) => a.taskId === first.task.id)!;
    expect(approval).toMatchObject({
      state: 'approved',
      decisionActor: 'project-policy:1',
      enforcementMode: 'cooperative',
    });
    expect(readFileSync(join(executionDirectory(f.storage), 'auto-policy.txt'), 'utf8')).toBe(
      'after',
    );
    save('deny');
    const second = f.runtime.submitGoal('project', { objective: 'native-denied' });
    await expect
      .poll(() => f.runtime.getTask(second.task.id).state, { timeout: 6000 })
      .toBe('completed');
    expect(
      f.storage.repositories.approvals.list().find((a) => a.taskId === second.task.id),
    ).toMatchObject({ state: 'rejected', decisionActor: 'project-policy:2' });
  });
  it.each(['full', 'missing'])(
    'publishes authoritative read-only decision eligibility for %s',
    async (mode) => {
      const f = await fixture(),
        { approval } = await pending(f, mode);
      const before = JSON.stringify(f.storage.repositories.approvals.list());
      const list = (await f.app.inject({ method: 'GET', url: '/api/approvals' })).json();
      const view = list.find((item: { id: string }) => item.id === approval.id);
      expect(view.decisionEligibility).toMatchObject({
        canApprove: mode === 'full',
        canReject: true,
        reason: mode === 'full' ? 'current_complete' : 'details_missing',
      });
      const snapshot = (await f.app.inject({ method: 'GET', url: '/api/control-center' })).json();
      expect(
        snapshot.approvals.find((item: { id: string }) => item.id === approval.id)
          .decisionEligibility.canApprove,
      ).toBe(mode === 'full');
      expect(JSON.stringify(f.storage.repositories.approvals.list()) === before).toBe(true);
      expect((await decide(f, approval.id, 'reject')).statusCode).toBe(200);
    },
  );
  it.each(['large', 'auth-basic', 'sdk-filter'])(
    'does not advertise approve for %s summaries',
    async (mode) => {
      const f = await fixture(),
        { approval } = await pending(f, mode);
      const views = (await f.app.inject({ method: 'GET', url: '/api/approvals' })).json();
      expect(
        views.find((item: { id: string }) => item.id === approval.id).decisionEligibility,
      ).toMatchObject({ canApprove: false, canReject: true });
      expect((await decide(f, approval.id)).statusCode).toBe(409);
      expect((await decide(f, approval.id, 'reject')).statusCode).toBe(200);
    },
  );
  it('never treats a public eligibility view as authority after execution changes', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f);
    const before = (await f.app.inject({ method: 'GET', url: '/api/approvals' }))
      .json()
      .find((item: { id: string }) => item.id === approval.id);
    expect(before.decisionEligibility.canApprove).toBe(true);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/approvals/${approval.id}/approve`,
          payload: { decisionEligibility: before.decisionEligibility },
        })
      ).statusCode,
    ).toBe(400);
    await f.runtime.cancelTask(submitted.task.id);
    const after = (await f.app.inject({ method: 'GET', url: '/api/approvals' }))
      .json()
      .find((item: { id: string }) => item.id === approval.id);
    expect(after.decisionEligibility).toMatchObject({
      canApprove: false,
      canReject: false,
      reason: 'approval_expired',
    });
    expect((await decide(f, approval.id)).statusCode).toBe(409);
  });
  it('keeps an actual current allow_once request usable beside isolated historical records', async () => {
    const f = await fixture();
    const marker = Buffer.from('synthetic-user:R3_SYNTHETIC_CANARY').toString('base64');
    const raw = JSON.stringify({
      id: 'isolated-history',
      projectId: 'project',
      action: 'acp.tool',
      boundary: 'acp-permission',
      resource: { description: 'Authorization: Basic ' + marker },
      state: 'pending',
      enforcementMode: 'cooperative',
      requestedAt: '2026-10-21T00:00:00Z',
    });
    f.storage.sqlite
      .prepare('INSERT INTO approvals(id,project_id,state,payload) VALUES(?,?,?,?)')
      .run('isolated-history', 'project', 'pending', raw);
    const { submitted, approval } = await pending(f);
    expect(f.runtime.readApprovals().diagnostics).toEqual({
      code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED',
      count: 1,
    });
    expect((await decide(f, 'isolated-history')).statusCode).toBe(409);
    expect((await decide(f, approval.id)).statusCode).toBe(200);
    await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
    const receipt = JSON.parse(
      readFileSync(join(executionDirectory(f.storage), 'permission-ack.jsonl'), 'utf8'),
    );
    expect(receipt.outcome).toEqual({ outcome: 'selected', optionId: 'once' });
    expect(
      (
        f.storage.sqlite
          .prepare('SELECT payload FROM approvals WHERE id=?')
          .get('isolated-history') as { payload: string }
      ).payload === raw,
    ).toBe(true);
    const observed = await f.app.inject({ method: 'GET', url: '/api/control-center' });
    expect(observed.statusCode).toBe(200);
    expect(observed.body.includes(marker)).toBe(false);
  });
  it('isolates legacy unsafe rows before approval and control-center output while keeping queries available', async () => {
    const f = await fixture();
    const encoded = Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64');
    const value = {
      id: 'unsafe-synthetic-legacy',
      projectId: 'project',
      action: 'acp.tool',
      boundary: 'acp-permission',
      resource: { description: 'Authorization: Basic ' + encoded },
      enforcementMode: 'cooperative',
      state: 'pending',
      requestedAt: '2026-10-21T00:00:00Z',
    };
    f.storage.sqlite
      .prepare('INSERT INTO approvals(id,project_id,state,payload) VALUES(?,?,?,?)')
      .run(value.id, value.projectId, value.state, JSON.stringify(value));
    try {
      for (const url of ['/api/approvals', '/api/control-center']) {
        const response = await f.app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.body.includes(encoded)).toBe(false);
      }
      expect((await decide(f, value.id)).statusCode).toBe(409);
      expect(f.storage.repositories.approvals.list()).toEqual([]);
    } finally {
      f.storage.sqlite.prepare('DELETE FROM approvals WHERE id = ?').run(value.id);
    }
  });
  it.each(['auth-basic', 'uppercase-url'])(
    'does not publish or persist %s synthetic credentials through the native ACP path',
    async (mode) => {
      const f = await fixture(),
        { submitted, approval } = await pending(f, mode);
      const secrets = [
        Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64'),
        'ONLY_SYNTHETIC_URL_CANARY',
        'ONLY_SYNTHETIC_QUERY_CANARY',
      ];
      const contains = (value: unknown) =>
        secrets.some((secret) => JSON.stringify(value).includes(secret));
      const api = await f.app.inject({ method: 'GET', url: '/api/approvals' });
      const center = await f.app.inject({ method: 'GET', url: '/api/control-center' });
      const facts = {
        mode,
        syntheticOnly: true,
        reviewStatus: approval.acp?.review.status,
        reviewLeak: contains(approval),
        apiLeak: contains(api.body) || contains(center.body),
        eventLeak: contains(f.runtime.taskEvents(submitted.task.id)),
        sqliteLeak: contains(
          f.storage.sqlite
            .prepare('SELECT payload FROM approvals UNION ALL SELECT payload FROM events')
            .all(),
        ),
      };
      if (process.env.CONTROL_PLANE_STAGE1_EVIDENCE) {
        mkdirSync(process.env.CONTROL_PLANE_STAGE1_EVIDENCE, { recursive: true });
        writeFileSync(
          join(process.env.CONTROL_PLANE_STAGE1_EVIDENCE, 'sensitive-facts-' + mode + '.json'),
          JSON.stringify(facts, null, 2),
        );
      }
      expect((await decide(f, approval.id)).statusCode).toBe(409);
      expect((await decide(f, approval.id, 'reject')).statusCode).toBe(200);
      await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
      expect(facts.reviewLeak || facts.apiLeak || facts.eventLeak || facts.sqliteLeak).toBe(false);
      expect(facts.reviewStatus).not.toBe('complete');
    },
  );
  it('refuses legacy unknown approvals at the actual server decision boundary', async () => {
    const { app, storage } = await fixture();
    storage.repositories.approvals.upsert(
      ApprovalSchema.parse({
        id: 'legacy',
        projectId: 'project',
        action: 'acp.tool',
        resource: {},
        state: 'pending',
        enforcementMode: 'cooperative',
        boundary: 'acp-permission',
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/approvals/legacy/approve', payload: {} }))
        .statusCode,
    ).toBe(409);
    expect(storage.repositories.approvals.get('legacy')?.state).not.toBe('approved');
  });

  it('preserves independent non-ACP policy boundaries and refuses unmarked legacy ACP records', async () => {
    const f = await fixture();
    const base = {
      projectId: 'project',
      action: 'acp.tool',
      resource: {},
      state: 'pending',
      enforcementMode: 'cooperative',
      requestedAt: new Date().toISOString(),
    };
    f.storage.repositories.approvals.upsert({
      ...base,
      id: 'other-boundary',
      boundary: 'fleet-policy',
    });
    f.storage.repositories.approvals.upsert({ ...base, id: 'unmarked-legacy' });
    expect((await decide(f, 'other-boundary')).statusCode).toBe(200);
    expect((await decide(f, 'unmarked-legacy')).statusCode).toBe(409);
  });

  it('persists correlated detail and exact execution identity through the actual ACP child', async () => {
    const { app, storage, runtime } = await fixture();
    const submitted = runtime.submitGoal('project', { objective: 'partial' });
    await expect.poll(() => runtime.listApprovals('pending').length, { timeout: 5000 }).toBe(1);
    const approval = runtime.listApprovals('pending')[0]!;
    expect(approval).toMatchObject({
      acp: {
        version: 1,
        attemptId: submitted.attempt.id,
        sessionId: permissionIdentity('fixture-session'),
        review: {
          tool: 'workspace.read',
          action: 'read',
          target: 'synthetic.txt',
          historyUsed: true,
          status: 'complete',
        },
      },
    });
    expect(JSON.stringify(storage.repositories.approvals.list())).not.toContain('CANARY');
    const denied = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/reject`,
      payload: {},
    });
    expect(denied.statusCode).toBe(200);
    await expect.poll(() => runtime.getTask(submitted.task.id).state).toBe('completed');
    const workspace = { rootPath: executionDirectory(storage) };
    expect(readFileSync(join(workspace.rootPath, 'permission-ack.jsonl'), 'utf8')).toContain(
      'cancelled',
    );
  });

  it.each(['missing', 'large', 'sdk-filter'])(
    'refuses %s approval but delivers explicit rejection to the child',
    async (mode) => {
      const f = await fixture(),
        { submitted, approval } = await pending(f, mode);
      expect(approval.acp?.review.status).not.toBe('complete');
      expect(JSON.stringify(f.runtime.listApprovals())).not.toContain('CANARY');
      expect((await decide(f, approval.id)).statusCode).toBe(409);
      expect(f.runtime.listApprovals('pending')).toHaveLength(1);
      expect((await decide(f, approval.id, 'reject')).statusCode).toBe(200);
      await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
      const artifact = await f.runtime.loadArtifact(
        f.runtime.getTask(submitted.task.id).resultArtifactRefs[0]!,
      );
      expect(new TextDecoder().decode(artifact.content)).toBe('{"outcome":"cancelled"}');
    },
  );

  it('allows only one explicit allow_once and makes concurrent duplicate decisions harmless', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f);
    expect(approval.acp?.review.status).toBe('complete');
    const results = await Promise.all([
      decide(f, approval.id),
      decide(f, approval.id),
      decide(f, approval.id, 'reject'),
    ]);
    expect(results[0]!.statusCode).toBe(200);
    expect([200, 409]).toContain(results[1]!.statusCode);
    expect(results[2]!.statusCode).toBe(409);
    await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
    const text = readFileSync(join(executionDirectory(f.storage), 'permission-ack.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text).outcome).toEqual({ outcome: 'selected', optionId: 'once' });
    expect(
      f.runtime.taskEvents(submitted.task.id).filter((e) => e.type === 'approval.decided'),
    ).toHaveLength(1);
    expect((await decide(f, approval.id)).statusCode).toBe(409);
  });

  it('rejects requests for an unrelated session without creating an approval', async () => {
    const f = await fixture();
    const submitted = f.runtime.submitGoal('project', { objective: 'wrong-session' });
    await expect
      .poll(() => f.runtime.getTask(submitted.task.id).state, { timeout: 5000 })
      .toBe('completed');
    expect(f.runtime.listApprovals()).toHaveLength(0);
    const text = readFileSync(join(executionDirectory(f.storage), 'permission-ack.jsonl'), 'utf8');
    expect(JSON.parse(text).outcome).toEqual({ outcome: 'cancelled' });
  });

  it.each(['duplicate-options', 'only-always'])(
    'refuses %s options without a durable approval',
    async (mode) => {
      const f = await fixture();
      const submitted = f.runtime.submitGoal('project', { objective: mode });
      await expect
        .poll(() => f.runtime.getTask(submitted.task.id).state, { timeout: 5000 })
        .toBe('completed');
      expect(f.runtime.listApprovals()).toHaveLength(0);
      expect(
        JSON.parse(
          readFileSync(join(executionDirectory(f.storage), 'permission-ack.jsonl'), 'utf8'),
        ).outcome,
      ).toEqual({ outcome: 'cancelled' });
    },
  );

  it('does not share an approval between concurrent ACP permission requests', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f, 'concurrent');
    expect((await decide(f, approval.id)).statusCode).toBe(200);
    await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
    expect(f.runtime.listApprovals()).toHaveLength(1);
    const receipts = readFileSync(
      join(executionDirectory(f.storage), 'permission-ack.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).outcome);
    expect(receipts).toEqual([{ outcome: 'cancelled' }, { outcome: 'selected', optionId: 'once' }]);
  });

  it('invalidates immediately on task cancellation; old page cannot approve or resume cancelled work', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f);
    await f.runtime.cancelTask(submitted.task.id);
    expect(f.storage.repositories.approvals.get(approval.id)).toMatchObject({
      state: 'expired',
      expiryReason: 'task-cancelled',
    });
    expect((await decide(f, approval.id)).statusCode).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/tasks/${submitted.task.id}/resume`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
  });

  it.each(['attempt', 'session', 'request', 'project', 'agent'])(
    'checks %s binding at actual server decision, not only at creation',
    async (field) => {
      const f = await fixture(),
        { submitted, approval } = await pending(f);
      const binding = approval.acp!;
      f.storage.repositories.approvals.upsert({
        ...approval,
        ...(field === 'project' ? { projectId: 'other-project' } : {}),
        ...(field === 'agent' ? { requesterAgentId: 'other-agent' } : {}),
        acp: {
          ...binding,
          ...(field === 'attempt' ? { attemptId: 'old-attempt' } : {}),
          ...(field === 'session' ? { sessionId: permissionIdentity('old-session') } : {}),
          ...(field === 'request' ? { requestId: '00000000-0000-4000-8000-000000000000' } : {}),
        },
      });
      expect((await decide(f, approval.id)).statusCode).toBe(409);
      expect(f.storage.repositories.approvals.get(approval.id)?.state).toBe('expired');
      await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
      const text = readFileSync(
        join(executionDirectory(f.storage), 'permission-ack.jsonl'),
        'utf8',
      );
      expect(JSON.parse(text).outcome).toEqual({ outcome: 'cancelled' });
    },
  );

  it('expires waits on deadline and never revives an old request', async () => {
    const f = await fixture(500),
      { submitted, approval } = await pending(f);
    await expect
      .poll(() => f.storage.repositories.approvals.get(approval.id)?.state, { timeout: 5000 })
      .toBe('expired');
    expect((await decide(f, approval.id)).statusCode).toBe(409);
    await expect.poll(() => f.runtime.getTask(submitted.task.id).state).toBe('completed');
    expect(f.storage.repositories.approvals.get(approval.id)?.expiryReason).toBe(
      'permission-timeout',
    );
  });

  it('invalidates pending ownership when the actual child exits, without a selected replay', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f, 'exit');
    writeFileSync(join(executionDirectory(f.storage), 'exit-now'), 'synthetic test trigger');
    await expect
      .poll(() => f.runtime.getTask(submitted.task.id).state, { timeout: 5000 })
      .toBe('failed');
    expect(f.storage.repositories.approvals.get(approval.id)?.state).toBe('expired');
    expect((await decide(f, approval.id)).statusCode).toBe(409);
  });

  it('rechecks ownership after a saved approval when cancellation wins before the ACP reply', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f);
    // Both operations are synchronous up to cancelTask's first await. This
    // forces the persisted-decision / broker-poll gap without a timing sleep.
    f.runtime.decideApproval(approval.id, 'approved', 'test-user');
    await f.runtime.cancelTask(submitted.task.id);
    const receipt = join(executionDirectory(f.storage), 'permission-ack.jsonl');
    if (existsSync(receipt)) expect(readFileSync(receipt, 'utf8')).not.toContain('selected');
    expect((await decide(f, approval.id)).statusCode).toBe(409);
    expect(f.storage.repositories.executionAttempts.get(submitted.attempt.id)?.state).toBe(
      'cancelled',
    );
  });

  it('restores stopped SQLite backup without replay; resumed attempt cannot use old approval even with reused ACP session id', async () => {
    const f = await fixture(),
      { submitted, approval } = await pending(f, 'partial');
    await f.runtime.close();
    expect(f.storage.repositories.approvals.get(approval.id)?.state).toBe('expired');
    const restoredFile = join(f.directory, 'restored.sqlite');
    await createConsistentSqliteSnapshot(join(f.directory, 'state.sqlite'), restoredFile);
    const restored = openSqliteStorage({ filename: restoredFile });
    const runtime = createControlPlaneRuntime({
      storage: restored,
      workspaceRoot: join(f.directory, 'restored-workspaces'),
      artifactRoot: join(f.directory, 'restored-artifacts'),
    });
    const app = buildServer({
      agentControl: runtime.agentControl,
      taskControl: runtime,
      fleetGateway: runtime.fleetGateway,
    });
    disposers.push(async () => {
      await runtime.close();
      await app.close();
      restored.close();
    });
    runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
    expect(restored.repositories.executionAttempts.list()).toHaveLength(1);
    expect(restored.repositories.executionAttempts.get(submitted.attempt.id)?.state).toBe(
      'interrupted',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/approvals/${approval.id}/approve`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const retried = runtime.resumeTask(submitted.task.id);
    await expect.poll(() => runtime.listApprovals('pending').length, { timeout: 5000 }).toBe(1);
    const current = runtime.listApprovals('pending')[0]!;
    expect(current.acp?.attemptId).toBe(retried.attempt.id);
    expect(current.acp?.attemptId).not.toBe(approval.acp?.attemptId);
    expect(current.acp?.sessionId).toBe(approval.acp?.sessionId);
    expect(current.acp?.requestId).not.toBe(approval.acp?.requestId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/approvals/${approval.id}/approve`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/approvals/${current.id}/reject`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await expect.poll(() => runtime.getTask(submitted.task.id).state).toBe('completed');
    expect(restored.repositories.executionAttempts.list()).toHaveLength(2);
    if (process.env.CONTROL_PLANE_STAGE1_EVIDENCE) {
      await runtime.close();
      const destination = process.env.CONTROL_PLANE_STAGE1_EVIDENCE;
      mkdirSync(destination, { recursive: true });
      const snapshot = join(destination, 'restored-state-' + randomUUID() + '.sqlite');
      await createConsistentSqliteSnapshot(restoredFile, snapshot);
      writeFileSync(
        snapshot + '.json',
        JSON.stringify(
          {
            testName: expect.getState().currentTestName,
            realModels: 0,
            approvals: restored.repositories.approvals.list(),
            attempts: restored.repositories.executionAttempts.list(),
            oldApprovalId: approval.id,
            currentApprovalId: current.id,
            noReplayBeforeExplicitResume: true,
          },
          null,
          2,
        ),
      );
    }
  });
});
