import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';

type Trace = {
  type: string;
  model: string;
  thought: string;
  configId?: string;
  value?: string;
  followup?: boolean;
  text?: string;
};

function fixture(reject: false | 'reject' | 'malformed' | 'idle-update' = false) {
  const root = mkdtempSync(join(tmpdir(), 'settings-execution-'));
  const filename = join(root, 'state.sqlite');
  const trace = join(root, 'wire-actions.jsonl');
  let storage = openSqliteStorage({ filename });
  const options = () => ({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  let runtime = createControlPlaneRuntime(options());
  runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  runtime.createProject({ id: 'p', name: 'Actual fixture execution' });
  runtime.setWorkspaceMode('p', { mode: 'task-local' });
  runtime.agentControl.create({
    id: 'worker',
    name: 'Settings fixture',
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../fixtures/session-settings-agent.mjs', import.meta.url)),
        trace,
        ...(reject === 'reject' ? ['--reject-large'] : []),
        ...(reject === 'malformed' ? ['--malformed-settings'] : []),
        ...(reject === 'idle-update' ? ['--idle-update'] : []),
      ],
    },
    auth: { mode: 'agent-managed' },
    capabilities: [],
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
  const readTrace = (): Trace[] =>
    existsSync(trace)
      ? readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Trace)
      : [];
  const settled = async (taskId: string, state: 'completed' | 'failed') => {
    await expect.poll(() => runtime.getTask(taskId).state, { timeout: 10_000 }).toBe(state);
    await expect.poll(() => runtime.taskExecutionActive(taskId), { timeout: 10_000 }).toBe(false);
  };
  const workspace = (taskId: string) => {
    const binding = storage.repositories.assignmentWorkspaces
      .list()
      .find((row) => row.taskId === taskId)!;
    return storage.repositories.workspaces.get(binding.workspaceId)!;
  };
  return {
    get storage() {
      return storage;
    },
    get runtime() {
      return runtime;
    },
    readTrace,
    settled,
    workspace,
    requestIdleUpdate: () => writeFileSync(trace + '.notify', 'update after prompt'),
    async reopen() {
      await runtime.close();
      storage.close();
      storage = openSqliteStorage({ filename });
      runtime = createControlPlaneRuntime(options());
      runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
    },
    async dispose() {
      await runtime.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('applies actual ACP choices before prompt and inherits the last confirmed settings across restart and followup', async () => {
  const f = fixture();
  try {
    const first = f.runtime.submitClientTask('fixture-client', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Create a file and CONFIRM_NEXT_THOUGHT',
      idempotencyKey: 'first',
      sessionSettings: { reasoning: 'high', model: 'large' },
    });
    await f.settled(first.task.id, 'completed');
    const firstTrace = f.readTrace();
    expect(
      firstTrace
        .filter((row) => row.type === 'set')
        .map(({ configId, value }) => ({ configId, value })),
    ).toEqual([
      { configId: 'model', value: 'large' },
      { configId: 'reasoning', value: 'high' },
    ]);
    expect(firstTrace.find((row) => row.type === 'prompt')).toMatchObject({
      model: 'large',
      thought: 'high',
      followup: false,
    });
    expect(readFileSync(join(f.workspace(first.task.id).rootPath, 'first.txt'), 'utf8')).toBe(
      'large/high',
    );
    const actual = f.runtime.sessionSettings.repository.getTask(first.task.id)!;
    expect(actual).toMatchObject({
      state: 'applied',
      requested: { model: 'large', reasoning: 'high' },
    });
    expect(actual.confirmed?.options.map((option) => [option.id, option.currentValue])).toEqual([
      ['model', 'large'],
      ['reasoning', 'low'],
    ]);
    expect(
      f.storage.repositories.events
        .listByProject('p')
        .some(
          (event) => event.taskId === first.task.id && event.type === 'execution.settings.updated',
        ),
    ).toBe(true);
    f.runtime.sessionSettings.repository.saveDefaults('worker', 0, {
      model: 'small',
      reasoning: 'low',
    });
    await f.reopen();
    const second = f.runtime.followUpTask(first.task.id, {
      content: 'Keep first.txt and add second.txt',
      idempotencyKey: 'next',
    });
    await f.settled(second.task.id, 'completed');
    expect(f.runtime.sessionSettings.repository.getTask(second.task.id)).toMatchObject({
      state: 'applied',
      requested: { model: 'large', reasoning: 'low' },
    });
    const secondTrace = f.readTrace().filter((row) => row.type === 'prompt')[1]!;
    expect(secondTrace).toMatchObject({ model: 'large', thought: 'low', followup: true });
    expect(secondTrace.text).toContain('Create a file and CONFIRM_NEXT_THOUGHT');
    expect(secondTrace.text).toContain('Settings fixture completed');
    expect(readFileSync(join(f.workspace(second.task.id).rootPath, 'second.txt'), 'utf8')).toBe(
      'large/high\nfollowup',
    );
    const sourceId = f.storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId;
    expect(
      existsSync(join(f.storage.repositories.workspaces.get(sourceId)!.rootPath, 'first.txt')),
    ).toBe(false);
    expect(f.storage.repositories.workspaceReviews.list()).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 25_000);

it('records rejected settings as a session_settings failure before any model prompt or file change', async () => {
  const f = fixture('reject');
  try {
    const task = f.runtime.submitClientTask('fixture-client', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'This task must not reach prompt',
      idempotencyKey: 'rejected',
      sessionSettings: { model: 'large' },
    });
    await f.settled(task.task.id, 'failed');
    expect(f.readTrace().map((row) => row.type)).toEqual(['new', 'set']);
    const state = f.runtime.sessionSettings.repository.getTask(task.task.id)!;
    expect(state).toMatchObject({ state: 'failed', requested: { model: 'large' } });
    expect(state.confirmed?.options[0]?.currentValue).toBe('small');
    expect(f.storage.repositories.executionAttempts.list()[0]?.failure).toMatchObject({
      code: 'SESSION_SETTINGS_REJECTED',
      retryable: true,
    });
    expect(
      f.storage.repositories.events
        .listByProject('p')
        .find((event) => event.taskId === task.task.id && event.type === 'execution.failed')
        ?.payload,
    ).toMatchObject({ stage: 'session_settings', code: 'SESSION_SETTINGS_REJECTED' });
    expect(JSON.stringify(state)).not.toContain('do-not-persist-provider-secret');
    expect(existsSync(join(f.workspace(task.task.id).rootPath, 'first.txt'))).toBe(false);
  } finally {
    await f.dispose();
  }
}, 15_000);

it('persists a legal configuration notification after the prompt iterator has ended', async () => {
  const f = fixture('idle-update');
  const publish = f.runtime.artifacts.publish.bind(f.runtime.artifacts);
  let reportReached = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = vi.spyOn(f.runtime.artifacts, 'publish').mockImplementation(async (...args) => {
    if (args[0].kind === 'report') {
      reportReached = true;
      await held;
    }
    return publish(...args);
  });
  try {
    const task = f.runtime.submitClientTask('fixture-client', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Create a file, then accept a late configuration notification',
      idempotencyKey: 'idle-update',
      sessionSettings: { model: 'large', reasoning: 'high' },
    });
    // Report publication is after promptWithDeliveries and prompt() finally;
    // the host's per-prompt queue is already gone, with no second prompt active.
    await expect.poll(() => reportReached, { timeout: 10_000 }).toBe(true);
    expect(
      f.runtime.sessionSettings.repository.getTask(task.task.id)?.confirmed?.options[1]
        ?.currentValue,
    ).toBe('high');
    f.requestIdleUpdate();
    await expect
      .poll(
        () =>
          f.runtime.sessionSettings.repository.getTask(task.task.id)?.confirmed?.options[1]
            ?.currentValue,
        { timeout: 5_000 },
      )
      .toBe('low');
    expect(f.readTrace().filter((row) => row.type === 'prompt')).toHaveLength(1);
    expect(f.readTrace().some((row) => row.type === 'idle-update')).toBe(true);
    release();
    await f.settled(task.task.id, 'completed');
    gate.mockRestore();
    await f.reopen();
    expect(f.runtime.sessionSettings.repository.getTask(task.task.id)).toMatchObject({
      state: 'applied',
      confirmed: { options: [expect.anything(), expect.objectContaining({ currentValue: 'low' })] },
    });
  } finally {
    release();
    gate.mockRestore();
    await f.dispose();
  }
}, 20_000);

it('fails malformed new-session settings at session_settings and never leaves a requested record or sends a prompt', async () => {
  const f = fixture('malformed');
  try {
    const task = f.runtime.submitClientTask('fixture-client', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Do not run with malformed settings',
      idempotencyKey: 'malformed',
      sessionSettings: { model: 'large' },
    });
    await f.settled(task.task.id, 'failed');
    expect(f.readTrace().map((row) => row.type)).toEqual(['new']);
    expect(f.runtime.sessionSettings.repository.getTask(task.task.id)).toMatchObject({
      state: 'failed',
      requested: { model: 'large' },
      confirmed: { source: 'unavailable', options: [] },
    });
    expect(
      f.storage.repositories.events
        .listByProject('p')
        .find((event) => event.taskId === task.task.id && event.type === 'execution.failed')
        ?.payload,
    ).toMatchObject({ stage: 'session_settings', code: 'SESSION_SETTINGS_INVALID_ADVERTISEMENT' });
    expect(existsSync(join(f.workspace(task.task.id).rootPath, 'first.txt'))).toBe(false);
  } finally {
    await f.dispose();
  }
}, 15_000);
