import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { ProjectPolicy } from '@control-plane/core';
import { openSqliteStorage } from '@control-plane/storage';
import { ClientAccessFileSchema, clientToolDefinitions } from '@control-plane/fleet-mcp';
import { ClientAccessGuard } from './client-access.js';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const token = 'c'.repeat(64);
function accessFile() {
  return ClientAccessFileSchema.parse({
    version: 1,
    clients: [
      {
        id: 'client',
        name: 'Client',
        enabled: true,
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        projects: [{ projectId: 'p' }],
        tools: clientToolDefinitions.map((tool) => tool.name),
      },
    ],
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'client-revocation-'));
  const storage = openSqliteStorage({ filename: ':memory:' });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  runtime.createProject({ id: 'p', name: 'Revocation project' });
  const access = accessFile();
  const app = buildServer({
    taskControl: runtime,
    clientGateway: { storage, runtime, readAccess: () => access },
  });
  const call = (toolName: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + token },
      payload: { toolName, input },
    });
  const close = async () => {
    await runtime.close();
    await app.close();
    storage.close();
    if (!root.startsWith(join(tmpdir(), 'client-revocation-')))
      throw Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  };
  return { root, storage, runtime, access, call, close };
}

it.each(['revoked', 'project-removed', 'tool-removed', 'token-rotated', 'policy-denied'] as const)(
  'rejects %s authority using current grants and policy',
  (change) => {
    const access = accessFile();
    const policy: Pick<ProjectPolicy, 'tools'> = { tools: {} };
    const guard = new ClientAccessGuard(
      () => access,
      () => policy,
    );
    const identity = guard.authenticate('Bearer ' + token);
    const authorize = () =>
      guard.authorize(identity, 'collaboration_prepare_review', 'p', ['control_get_task']);
    expect(authorize()).toEqual({ projectId: 'p' });
    const client = access.clients[0]!;
    if (change === 'revoked') client.enabled = false;
    if (change === 'project-removed') client.projects = [{ projectId: 'elsewhere' }];
    if (change === 'tool-removed') client.tools = ['collaboration_get_task'];
    if (change === 'token-rotated') client.tokenSha256 = 'd'.repeat(64);
    if (change === 'policy-denied') policy.tools.control_get_task = 'deny';
    expect(authorize).toThrow(expect.objectContaining({ statusCode: 403 }));
  },
);

it('fails closed without disclosing invalid or unreadable access configuration', () => {
  const access = accessFile();
  let readAccess: () => unknown = () => access;
  const guard = new ClientAccessGuard(
    () => readAccess(),
    () => ({ tools: {} }),
  );
  const identity = guard.authenticate('Bearer ' + token);
  const unavailable = {
    statusCode: 503,
    message: 'Local client access configuration is unavailable.',
  };
  for (const read of [
    () => ({ secret: 'do-not-echo' }),
    () => {
      throw Error('do-not-echo');
    },
  ]) {
    readAccess = read;
    expect(() => guard.authenticate('Bearer ' + token)).toThrow(
      expect.objectContaining(unavailable),
    );
    expect(() =>
      guard.authorize(identity, 'collaboration_prepare_review', 'p', ['control_get_task']),
    ).toThrow(expect.objectContaining(unavailable));
  }
});

it('rechecks authority after the review cleanup wait before preparing any durable result', async () => {
  const f = fixture();
  try {
    const task = f.runtime.taskEngine.createTask({
      id: 'ended',
      projectId: 'p',
      title: 'Ended',
      objective: 'Review',
      state: 'ready',
    });
    f.runtime.taskEngine.cancelTask(task.id);
    const waiting = deferred();
    let active = true;
    vi.spyOn(f.runtime, 'taskExecutionActive').mockImplementation(() => {
      waiting.resolve();
      return active;
    });
    const prepare = vi.spyOn(f.runtime, 'prepareWorkspaceReview');
    const result = Promise.resolve(f.call('collaboration_prepare_review', { taskId: task.id }));
    await waiting.promise;
    f.access.clients[0]!.enabled = false;
    active = false;
    expect((await result).statusCode).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(f.storage.repositories.workspaceReviews.list()).toHaveLength(0);
    expect(f.storage.repositories.approvals.list()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('refuses artifact and review commits when access is revoked during review IO, and allows an authorized retry', async () => {
  const f = fixture();
  const release = deferred();
  try {
    const source = f.storage.repositories.workspaces.get(
      f.storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId,
    )!;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: source.rootPath,
        windowsHide: true,
        encoding: 'utf8',
      }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source.rootPath, 'README.md'), 'Existing source\n');
    git('add', '.');
    git('commit', '-m', 'Initial');
    f.runtime.setWorkspaceMode('p', { mode: 'git-worktree' });
    f.runtime.agentControl.create({
      id: 'worker',
      name: 'Synthetic worker',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/client-worker-agent.mjs', import.meta.url))],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
    const submitted = await f.call('collaboration_submit_task', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Write first file',
      idempotencyKey: 'first',
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const taskId = submitted.json().result.task.id as string;
    await expect.poll(() => f.runtime.getTask(taskId).state, { timeout: 15000 }).toBe('completed');
    await expect.poll(() => f.runtime.taskExecutionActive(taskId), { timeout: 15000 }).toBe(false);
    const beforeArtifacts = f.storage.repositories.artifacts.list().length;
    const started = deferred();
    const publish = f.runtime.artifacts.publish.bind(f.runtime.artifacts);
    vi.spyOn(f.runtime.artifacts, 'publish').mockImplementationOnce(async (input, options) => {
      started.resolve();
      await release.promise;
      return publish(input, options);
    });
    const response = Promise.resolve(f.call('collaboration_prepare_review', { taskId }));
    await started.promise;
    f.access.clients[0]!.enabled = false;
    release.resolve();
    expect((await response).statusCode).toBe(403);
    expect(f.storage.repositories.artifacts.list()).toHaveLength(beforeArtifacts);
    expect(f.storage.repositories.workspaceReviews.list()).toHaveLength(0);
    expect(f.storage.repositories.approvals.list()).toHaveLength(0);
    f.access.clients[0]!.enabled = true;
    const retry = await f.call('collaboration_prepare_review', { taskId });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().result.requiresHumanReview).toBe(true);
    expect(f.storage.repositories.workspaceReviews.list()).toHaveLength(1);
    expect(f.storage.repositories.approvals.list()[0]?.state).toBe('pending');
    expect(existsSync(join(source.rootPath, 'first.txt'))).toBe(false);
  } finally {
    release.resolve();
    await f.close();
  }
}, 30000);
