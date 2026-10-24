import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { LocalRunner } from '@control-plane/runner';
import { AcpClientRuntime, type AcpRuntimeConnection } from '@control-plane/acp-runtime';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});

it('deduplicates draft creation through response loss and SQLite reopen without starting an agent', async () => {
  const f = fixture();
  const url = '/api/projects/p/tasks';
  const payload = { objective: 'Original creation request', idempotencyKey: 'stable-draft-key' };
  const first = await f.app.inject({ method: 'POST', url, payload });
  expect(first.statusCode).toBe(201);
  const task = first.json();
  expect((await f.app.inject({ method: 'POST', url, payload })).json().id).toBe(task.id);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        payload: { ...payload, objective: 'Different request' },
      })
    ).statusCode,
  ).toBe(409);
  expect(f.storage.repositories.tasks.list()).toHaveLength(1);
  const record = f.runtime.taskRecords.inspect(task.id);
  f.runtime.taskRecords.update(task.id, {
    version: record.version,
    objective: 'Edited durable draft',
  });
  const storage = await f.reopen();
  const reopened = createControlPlaneRuntime({ storage });
  try {
    expect(reopened.createDraft('p', payload)).toMatchObject({
      id: task.id,
      objective: 'Edited durable draft',
      state: 'draft',
    });
    expect(storage.repositories.tasks.list()).toHaveLength(1);
    expect(storage.repositories.executionAttempts.list()).toHaveLength(0);
    expect(f.spawn).not.toHaveBeenCalled();
  } finally {
    await reopened.close();
  }
});

it('continues a completed conversation with durable context, deduplicates sends and preserves old records across reopen', async () => {
  const f = fixture();
  f.runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  const prompts: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  vi.spyOn(AcpClientRuntime.prototype, 'connect').mockResolvedValue({
    capabilities: {},
    newSession: async () => ({ sessionId: 'synthetic-followup' }),
    close: () => {},
    prompt: async function* (_session: string, text: string) {
      prompts.push(text);
      if (prompts.length === 1) await firstGate;
      yield {
        type: 'text_delta',
        text:
          prompts.length <= 2
            ? 'Original durable answer: blue bird'
            : 'Revised answer based on blue bird',
        sessionId: 'synthetic-followup',
      };
      yield { type: 'completed', stopReason: 'end_turn', sessionId: 'synthetic-followup' };
    },
  } as unknown as AcpRuntimeConnection);
  f.runtime.agentControl.create({
    id: 'boss',
    name: 'Synthetic Boss',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'never-run', args: [] },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: true },
    controlBridge: { transport: 'mcp', scopes: ['boss.orchestration', 'artifact.read'] },
  });
  f.runtime.agentControl.selectBoss('p', 'boss');
  const first = f.runtime.submitGoal('p', { objective: 'Remember a blue bird' }).task;
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  f.runtime.submitConversationInput(first.id, {
    content: 'Keep the bird blue in later revisions',
    idempotencyKey: 'clarification',
  });
  const instructionReceipt = await f.app.inject({
    method: 'GET',
    url: `/api/tasks/${first.id}/chat-receipts/clarification`,
  });
  expect(instructionReceipt.statusCode).toBe(200);
  expect(instructionReceipt.json()).toMatchObject({
    kind: 'instruction',
    instruction: { taskId: first.id, content: 'Keep the bird blue in later revisions' },
  });
  expect(prompts).toHaveLength(1);
  releaseFirst();
  await vi.waitFor(() => {
    expect(
      f.runtime.getTask(first.id).state,
      JSON.stringify(f.runtime.taskEvents(first.id).filter((e) => e.type === 'execution.failed')),
    ).toBe('completed');
  });
  const original = f.runtime.getTask(first.id);
  const url = `/api/tasks/${first.id}/chat`;
  const payload = { content: 'Make the previous answer shorter', idempotencyKey: 'same-send' };
  const response = await f.app.inject({ method: 'POST', url, payload });
  expect(response.statusCode).toBe(202);
  const next = response.json().task;
  const receiptUrl = `/api/tasks/${first.id}/chat-receipts/same-send`;
  expect((await f.app.inject({ method: 'GET', url: receiptUrl })).json()).toMatchObject({
    kind: 'followup',
    task: { id: next.id },
  });
  expect(
    (
      await f.app.inject({ method: 'GET', url: `/api/tasks/${next.id}/chat-receipts/same-send` })
    ).json(),
  ).toEqual({ kind: 'missing' });
  expect(next.dependencyIds).toContain(first.id);
  expect(next.contextRefs).toEqual(original.resultArtifactRefs);
  expect((await f.app.inject({ method: 'POST', url, payload })).json()).toMatchObject({
    reused: true,
    task: { id: next.id },
  });
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        payload: { ...payload, content: 'Different message' },
      })
    ).statusCode,
  ).toBe(409);
  await vi.waitFor(() => expect(f.runtime.getTask(next.id).state).toBe('completed'));
  expect(prompts).toHaveLength(3);
  expect(prompts[2]).toContain('Make the previous answer shorter');
  expect(prompts[2]).toContain('Original durable answer: blue bird');
  expect(prompts[2]).toContain('Keep the bird blue in later revisions');
  expect(f.runtime.getTask(first.id)).toEqual(original);
  const scope = f.runtime as unknown as {
    artifactInScope(id: string, task: typeof original): boolean;
  };
  expect(scope.artifactInScope(original.resultArtifactRefs[0]!, f.runtime.getTask(next.id))).toBe(
    true,
  );
  expect(scope.artifactInScope(f.runtime.getTask(next.id).resultArtifactRefs[0]!, original)).toBe(
    false,
  );
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        payload: { ...payload, idempotencyKey: 'stale-round' },
      })
    ).statusCode,
  ).toBe(409);
  const storage = await f.reopen();
  expect(
    storage.repositories.events
      .listByProject('p')
      .filter((e) => e.type === 'task.followup.created'),
  ).toMatchObject([
    { taskId: next.id, payload: { sourceTaskId: first.id, conversationRootTaskId: first.id } },
  ]);
  const reopened = createControlPlaneRuntime({ storage });
  reopened.setBridgeBaseUrl('http://127.0.0.1:4000');
  try {
    expect(reopened.readConversationInput(first.id, 'same-send')).toMatchObject({
      kind: 'followup',
      task: { id: next.id },
    });
    expect(reopened.readConversationInput(first.id, 'clarification')).toMatchObject({
      kind: 'instruction',
      instruction: { content: 'Keep the bird blue in later revisions' },
    });
    expect(reopened.readConversationInput(first.id, 'unknown-send')).toEqual({ kind: 'missing' });
    expect(reopened.followUpTask(first.id, payload)).toMatchObject({
      reused: true,
      task: { id: next.id },
    });
    expect(storage.repositories.tasks.get(first.id)).toEqual(original);
    expect(prompts).toHaveLength(3);
  } finally {
    await reopened.close();
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-records-'));
  const filename = join(root, 'state.sqlite');
  let storage = openSqliteStorage({ filename });
  let runtimeClosed = false;
  const runner = new LocalRunner();
  const spawn = vi.spyOn(runner, 'spawn').mockResolvedValue({
    id: 'synthetic',
    runnerId: 'local',
    pid: 0,
    startedAt: new Date().toISOString(),
  });
  vi.spyOn(runner, 'transport').mockReturnValue({
    readable: new ReadableStream(),
    writable: new WritableStream(),
  });
  vi.spyOn(runner, 'stop').mockImplementation(async (handle) => ({ ...handle, state: 'exited' }));
  const runtime = createControlPlaneRuntime({
    storage,
    runner,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const app = buildServer({
    taskControl: runtime,
    agentControl: runtime.agentControl,
    fleetGateway: runtime.fleetGateway,
  });
  runtime.createProject({ id: 'p', name: 'Draft workflow' });
  disposers.push(async () => {
    await app.close();
    if (!runtimeClosed) await runtime.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    app,
    runtime,
    spawn,
    runner,
    root,
    get storage() {
      return storage;
    },
    reopen: async () => {
      await runtime.close();
      runtimeClosed = true;
      storage.close();
      storage = openSqliteStorage({ filename });
      return storage;
    },
  };
}

it('creates, edits and deletes unexecuted drafts through HTTP, preserving audit and stale-write protection after reopen', async () => {
  const f = fixture();
  const create = () =>
    f.app.inject({
      method: 'POST',
      url: '/api/projects/p/tasks',
      payload: { title: 'Draft', objective: 'Original requirement' },
    });
  const created = await create();
  expect(created.statusCode).toBe(201);
  const task = created.json();
  const url = '/api/tasks/' + task.id;
  const view = (await f.app.inject({ method: 'GET', url: url + '/record' })).json();
  expect(view).toMatchObject({ canEditObjective: true, canDelete: true });
  const changed = await f.app.inject({
    method: 'PATCH',
    url,
    payload: { version: view.version, title: 'Edited draft', objective: 'Approved requirement' },
  });
  expect(changed.statusCode).toBe(200);
  expect(
    (await f.app.inject({ method: 'DELETE', url, payload: { version: view.version } })).statusCode,
  ).toBe(409);
  const linked = f.runtime.taskEngine.createTask({
    id: 'dependent',
    projectId: 'p',
    title: 'Later task',
    objective: 'Depends on draft',
    dependencyIds: [task.id],
  });
  expect(
    (await f.app.inject({ method: 'DELETE', url, payload: { version: changed.json().version } }))
      .statusCode,
  ).toBe(409);
  f.runtime.taskEngine.setDependencies(linked.id, []);
  const spare = (await create()).json();
  const spareView = f.runtime.taskRecords.inspect(spare.id);
  expect(
    (
      await f.app.inject({
        method: 'DELETE',
        url: '/api/tasks/' + spare.id,
        payload: { version: spareView.version },
      })
    ).statusCode,
  ).toBe(200);
  expect((await f.app.inject({ method: 'GET', url: '/api/tasks/' + spare.id })).statusCode).toBe(
    404,
  );
  expect(f.spawn).not.toHaveBeenCalled();
  const storage = await f.reopen();
  expect(storage.repositories.tasks.get(task.id)).toMatchObject({
    state: 'draft',
    title: 'Edited draft',
    objective: 'Approved requirement',
  });
  expect(storage.repositories.tasks.get(spare.id)).toBeUndefined();
  expect(
    storage.repositories.events
      .listByProject('p')
      .filter((row) => row.type === 'task.draft_deleted'),
  ).toHaveLength(1);
  expect(
    storage.repositories.events.listByProject('p').find((row) => row.type === 'task.record_updated')
      ?.payload,
  ).toMatchObject({ previousObjective: 'Original requirement', objective: 'Approved requirement' });
});

it('starts a non-Boss directly and retains worker mode through restart, retry and follow-up', async () => {
  const f = fixture();
  f.runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  const prompts: string[] = [];
  vi.spyOn(AcpClientRuntime.prototype, 'connect').mockResolvedValue({
    capabilities: {},
    newSession: async () => ({ sessionId: 'direct-session' }),
    close: () => {},
    prompt: async function* (_session: string, text: string) {
      prompts.push(text);
      if (prompts.length === 1) throw new Error('Controlled transport failure');
      yield { type: 'text_delta', text: 'Remember blue bird', sessionId: 'direct-session' };
      yield { type: 'completed', stopReason: 'end_turn', sessionId: 'direct-session' };
    },
  } as unknown as AcpRuntimeConnection);
  f.runtime.agentControl.create({
    id: 'worker',
    name: 'Direct member',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'never-run', args: [] },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
  const task = f.runtime.createDraft('p', { objective: 'Keep a blue bird' });
  const version = f.runtime.taskRecords.inspect(task.id).version;
  const request = {
    method: 'POST' as const,
    url: `/api/tasks/${task.id}/start`,
    payload: { version, mode: 'direct', agentId: 'worker' },
  };
  expect((await f.app.inject(request)).statusCode).toBe(200);
  expect((await f.app.inject(request)).statusCode).toBe(409);
  await vi.waitFor(() => expect(f.runtime.getTask(task.id).state).toBe('failed'));
  await vi.waitFor(() => expect(f.runtime.taskExecutionActive(task.id)).toBe(false));
  const storage = await f.reopen();
  const runtime = createControlPlaneRuntime({
    storage,
    runner: f.runner,
    workspaceRoot: join(f.root, 'workspaces'),
    artifactRoot: join(f.root, 'artifacts'),
  });
  runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  try {
    const retry = runtime.resumeTask(task.id);
    expect(retry.assignment.role?.name).toBe('Collaborator');
    await vi.waitFor(() => expect(runtime.getTask(task.id).state).toBe('completed'));
    const next = runtime.followUpTask(task.id, {
      content: 'Shorten the previous answer',
      idempotencyKey: 'direct-followup',
    });
    await vi.waitFor(() => expect(runtime.getTask(next.task.id).state).toBe('completed'));
    expect(prompts).toHaveLength(3);
    expect(prompts.every((prompt) => !prompt.includes('Collaboration workflow:'))).toBe(true);
    expect(prompts[2]).toContain('Keep a blue bird');
    expect(prompts[2]).toContain('Remember blue bird');
    expect(
      storage.repositories.assignments.list().every((a) => a.role?.name === 'Collaborator'),
    ).toBe(true);
    expect(runtime.getProject('p').defaultBossAgentId).toBeUndefined();
    expect(storage.repositories.agentDefinitions.get('worker')?.orchestration.canBeBoss).toBe(
      false,
    );
  } finally {
    await runtime.close();
  }
});

it('starts the saved draft once with its reviewed objective, then only permits title changes and retains execution history', async () => {
  const f = fixture();
  f.runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  vi.spyOn(AcpClientRuntime.prototype, 'connect').mockResolvedValue({
    capabilities: {},
    newSession: async () => ({ sessionId: 'synthetic-session' }),
    close: () => release(),
    prompt: async function* (_session: string, text: string) {
      prompts.push(text);
      await done;
      yield { type: 'text_delta', text: 'Draft executed', sessionId: 'synthetic-session' };
      yield { type: 'completed', stopReason: 'end_turn', sessionId: 'synthetic-session' };
    },
  } as unknown as AcpRuntimeConnection);
  f.runtime.agentControl.create({
    id: 'boss',
    name: 'Synthetic Boss',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'never-run', args: [] },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: true },
    controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
  });
  f.runtime.agentControl.selectBoss('p', 'boss');
  const task = f.runtime.createDraft('p', {
    title: 'Saved task',
    objective: 'Execute this exact draft',
  });
  const view = f.runtime.taskRecords.inspect(task.id),
    url = '/api/tasks/' + task.id;
  const start = () =>
    f.app.inject({
      method: 'POST',
      url: url + '/start',
      payload: { version: view.version, bossAgentId: 'boss' },
    });
  expect((await start()).statusCode).toBe(200);
  expect((await start()).statusCode).toBe(409);
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  expect(prompts[0]).toContain('Execute this exact draft');
  const current = f.runtime.taskRecords.inspect(task.id);
  expect(current).toMatchObject({ canEditObjective: false, canDelete: false });
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url,
        payload: { version: current.version, objective: 'Changed execution' },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await f.app.inject({ method: 'DELETE', url, payload: { version: current.version } }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url,
        payload: { version: current.version, title: 'Readable title' },
      })
    ).statusCode,
  ).toBe(200);
  release();
  await vi.waitFor(() => expect(f.runtime.getTask(task.id).state).toBe('completed'));
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.storage.repositories.assignments.list()).toHaveLength(1);
  expect(f.storage.repositories.tasks.list()).toHaveLength(1);
  expect(f.runtime.getTask(task.id)).toMatchObject({
    title: 'Readable title',
    objective: 'Execute this exact draft',
  });
  const storage = await f.reopen();
  expect(storage.repositories.tasks.get(task.id)?.state).toBe('completed');
  expect(storage.repositories.executionAttempts.list()).toHaveLength(1);
});
