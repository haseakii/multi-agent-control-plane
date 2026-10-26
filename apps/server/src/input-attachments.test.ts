import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { TaskSchema, WorkspaceSchema, type Task } from '@control-plane/core';
import {
  openSqliteStorage,
  SqliteInputAttachmentRepository,
  createConsistentSqliteSnapshot,
} from '@control-plane/storage';
import { LocalGitReviewAdapter } from '@control-plane/workspace';
import { inputAttachmentTaskScope } from './input-attachments.js';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);
function fixture() {
  return mkdtempSync(join(tmpdir(), 'input-attachments-'));
}
function cleanup(root: string) {
  if (
    !resolve(root).startsWith(resolve(tmpdir()) + '\\input-attachments-') &&
    !resolve(root).startsWith(resolve(tmpdir()) + '/input-attachments-')
  )
    throw Error('Unexpected fixture root');
  rmSync(root, { recursive: true, force: true });
}
it('upgrades nineteen migrations, preserves binary inputs through backup/reopen, freezes message identities, and verifies content integrity', async () => {
  const root = fixture(),
    filename = join(root, 'state.sqlite'),
    folder = join(root, 'old');
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(
        new URL('../../../packages/storage/drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    );
    journal.entries = journal.entries.slice(0, 19);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const item of journal.entries)
      copyFileSync(
        new URL('../../../packages/storage/drizzle/' + item.tag + '.sql', import.meta.url),
        join(folder, item.tag + '.sql'),
      );
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 22,
    });
    const runtime = createControlPlaneRuntime({
      storage,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
    runtime.createProject({ id: 'p', name: 'Input fixture' });
    const service = runtime.inputAttachments,
      a = service.upload('参考.png', 'text/html', png),
      b = service.upload('notes.txt', 'text/plain', Buffer.from('retain blue-pine-37'));
    const task = runtime.createDraft('p', { objective: 'fixture', attachmentIds: [a.id, b.id] });
    service.repository.bind(task.id, task.id, [a.id, b.id]);
    expect(() => service.repository.bind(task.id, task.id, [b.id])).toThrow('冻结');
    expect(service.repository.removeUnbound(a.id)).toBe(false);
    expect(a).toMatchObject({ image: true, mimeType: 'image/png' });
    expect(() => service.upload('../escape', 'text/plain', Buffer.from('x'))).toThrow();
    await runtime.close();
    storage.close();
    await createConsistentSqliteSnapshot(filename, join(root, 'backup.sqlite'));
    storage = openSqliteStorage({ filename: join(root, 'backup.sqlite') });
    const reopened = new SqliteInputAttachmentRepository(storage.sqlite);
    expect(reopened.forTask(task.id).map((a) => a.name)).toEqual(['参考.png', 'notes.txt']);
    expect(Buffer.from(reopened.read(a.id))).toEqual(png);
    storage.sqlite
      .prepare('UPDATE input_attachments SET content=? WHERE id=?')
      .run(Buffer.from('corrupt'), a.id);
    expect(() => reopened.read(a.id)).toThrow('完整性');
  } finally {
    if (storage?.sqlite.open) storage.close();
    cleanup(root);
  }
});
it('uploads actual binary bytes with safe download headers, and keeps managed copies out of source snapshots', async () => {
  const root = fixture(),
    storage = openSqliteStorage({ filename: ':memory:' });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const app = buildServer({ taskControl: runtime });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/input-attachments?name=reference.png&mimeType=text%2Fhtml',
      headers: { 'content-type': 'application/octet-stream' },
      payload: png,
    });
    expect(response.statusCode).toBe(200);
    const a = response.json();
    const content = await app.inject('/api/input-attachments/' + a.id + '/content');
    expect(content.headers['content-type']).toContain('image/png');
    expect(content.rawPayload).toEqual(png);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    const svg = runtime.inputAttachments.upload(
      'unsafe.svg',
      'image/svg+xml',
      Buffer.from('<svg onload="alert(1)"/>'),
    );
    const download = await app.inject('/api/input-attachments/' + svg.id + '/content');
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    expect(download.headers['content-type']).toContain('application/octet-stream');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, 'index.html'), '<h1>base</h1>');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseRevision = git('rev-parse', 'HEAD');
    runtime.createProject({ id: 'p', name: 'Input fixture' });
    const task = runtime.createDraft('p', { objective: 'fixture', attachmentIds: [a.id] });
    await runtime.inputAttachments.prepare([task.id], root);
    writeFileSync(join(root, 'index.html'), '<h1>edited</h1>');
    const captured = await new LocalGitReviewAdapter().capture(
      WorkspaceSchema.parse({
        id: 'w',
        projectId: 'p',
        provider: 'git-worktree',
        rootPath: root,
        baseRevision,
        access: 'read-write',
      }),
    );
    expect(captured.files.map((f) => f.path)).toEqual(['index.html']);
    expect(captured.patch).not.toContain('.control-plane-inputs');
  } finally {
    await app.close();
    await runtime.close();
    storage.close();
    cleanup(root);
  }
});
it('delivers native image and actual file content to a process, and carries them through a durable followup', async () => {
  const root = fixture(),
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  try {
    runtime.createProject({ id: 'p', name: 'Input fixture' });
    runtime.setWorkspaceMode('p', { mode: 'task-local' });
    runtime.agentControl.create({
      id: 'worker',
      name: 'Input fixture',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/input-worker.mjs', import.meta.url))],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
    const a = runtime.inputAttachments.upload('image.png', 'image/png', png),
      b = runtime.inputAttachments.upload(
        'notes.txt',
        'text/plain',
        Buffer.from('retain blue-pine-37'),
      );
    const first = runtime.submitClientTask('fixture-client', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Read input files',
      idempotencyKey: 'first',
      attachmentIds: [a.id, b.id],
    });
    await expect
      .poll(() => runtime.getTask(first.task.id).state, { timeout: 10000 })
      .toBe('completed');
    await expect
      .poll(() => runtime.taskExecutionActive(first.task.id), { timeout: 10000 })
      .toBe(false);
    const child = TaskSchema.parse({
      ...first.task,
      id: 'child',
      parentTaskId: first.task.id,
      dependencyIds: [],
    });
    const childScope = inputAttachmentTaskScope(child, (id) => runtime.getTask(id));
    expect(childScope).toContain(first.task.id);
    expect(() =>
      inputAttachmentTaskScope(child, () =>
        TaskSchema.parse({ ...first.task, projectId: 'other' }),
      ),
    ).toThrow('当前项目');
    const next = runtime.followUpTask(first.task.id, {
      content: 'Keep previous inputs and continue',
      idempotencyKey: 'followup',
    });
    expect(runtime.taskInputAttachments(next.task.id).map((a) => a.id)).toEqual([a.id, b.id]);
    await expect
      .poll(() => runtime.getTask(next.task.id).state, { timeout: 10000 })
      .toBe('completed');
    await expect
      .poll(() => runtime.taskExecutionActive(next.task.id), { timeout: 10000 })
      .toBe(false);
    const binding = storage.repositories.assignmentWorkspaces
      .list()
      .find((w) => w.taskId === next.task.id)!;
    const workspace = storage.repositories.workspaces.get(binding.workspaceId)!;
    expect(readFileSync(join(workspace.rootPath, 'input-proof.txt'), 'utf8')).toContain(
      'blue-pine-37',
    );
    expect(readFileSync(join(workspace.rootPath, 'followup-proof.txt'), 'utf8')).toContain(
      'native image',
    );
  } finally {
    await runtime.close();
    storage.close();
    cleanup(root);
  }
}, 25000);

it.each(['failed', 'cancelled'] as const)(
  'delivers original input bytes after a %s round and retains that link across restart',
  async (state) => {
    const root = fixture(),
      filename = join(root, 'state.sqlite');
    let storage = openSqliteStorage({ filename });
    const createRuntime = () =>
      createControlPlaneRuntime({
        storage,
        workspaceRoot: join(root, 'workspaces'),
        artifactRoot: join(root, 'artifacts'),
      });
    let runtime = createRuntime();
    runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
    try {
      runtime.createProject({ id: 'p', name: 'Recovery inputs' });
      runtime.setWorkspaceMode('p', { mode: 'task-local' });
      runtime.agentControl.create({
        id: 'worker',
        name: 'Input fixture',
        enabled: true,
        runtime: {
          type: 'acp-stdio',
          command: process.execPath,
          args: [fileURLToPath(new URL('../fixtures/input-worker.mjs', import.meta.url))],
        },
        auth: { mode: 'agent-managed' },
        capabilities: [],
        orchestration: { canBeBoss: false },
        controlBridge: { transport: 'none', scopes: [] },
      });
      const original = runtime.taskEngine.createTask({
        id: 'original',
        projectId: 'p',
        title: 'Original input',
        objective: 'Read references',
        state: 'ready',
      });
      const image = runtime.inputAttachments.upload('image.png', 'image/png', png);
      const file = runtime.inputAttachments.upload(
        'notes.txt',
        'text/plain',
        Buffer.from('retain blue-pine-37'),
      );
      runtime.inputAttachments.repository.bind(original.id, original.id, [image.id, file.id]);
      const assignment = runtime.taskEngine.createAssignment({
        id: 'original-assignment',
        taskId: original.id,
        agentId: 'worker',
        objective: original.objective,
        role: { name: 'Collaborator' },
      });
      const attempt = runtime.taskEngine.createAttempt(assignment.id);
      runtime.taskEngine.startAttempt(attempt.id);
      if (state === 'cancelled') runtime.taskEngine.cancelTask(original.id);
      else
        runtime.taskEngine.finishAttempt(attempt.id, {
          outcome: 'failed',
          failure: { code: 'SYNTHETIC_FAILURE', message: 'Synthetic failure', retryable: true },
        });
      await runtime.close();
      storage.close();
      storage = openSqliteStorage({ filename });
      runtime = createRuntime();
      runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
      const next = runtime.followUpTask(original.id, {
        content: 'Continue reading the original inputs',
        idempotencyKey: 'next',
      });
      expect(runtime.taskInputAttachments(next.task.id).map((a) => a.id)).toEqual([
        image.id,
        file.id,
      ]);
      await expect
        .poll(() => runtime.getTask(next.task.id).state, { timeout: 10000 })
        .toBe('completed');
      await expect
        .poll(() => runtime.taskExecutionActive(next.task.id), { timeout: 10000 })
        .toBe(false);
      const binding = storage.repositories.assignmentWorkspaces
        .list()
        .find((b) => b.taskId === next.task.id)!;
      const workspace = storage.repositories.workspaces.get(binding.workspaceId)!;
      expect(readFileSync(join(workspace.rootPath, 'followup-proof.txt'), 'utf8')).toContain(
        'native image + real file + blue-pine-37',
      );
      await runtime.close();
      storage.close();
      storage = openSqliteStorage({ filename });
      runtime = createRuntime();
      expect(runtime.taskInputAttachments(next.task.id).map((a) => a.id)).toEqual([
        image.id,
        file.id,
      ]);
    } finally {
      await runtime.close();
      storage.close();
      cleanup(root);
    }
  },
  20000,
);

it('walks conversation inputs beyond the text context window and rejects corrupt project or cycle links', () => {
  const tasks = new Map<string, Task>();
  for (let index = 0; index < 1025; index++)
    tasks.set(
      'round-' + index,
      TaskSchema.parse({
        id: 'round-' + index,
        projectId: 'p',
        title: 'Round',
        objective: 'Continue',
        state: index % 2 ? 'failed' : 'completed',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: '2026-10-25T00:00:00Z',
        updatedAt: '2026-10-25T00:00:00Z',
      }),
    );
  const previous = (task: Task) =>
    Number(task.id.slice(6)) > 0 ? 'round-' + (Number(task.id.slice(6)) - 1) : undefined;
  const read = (id: string) => tasks.get(id)!;
  const last = TaskSchema.parse({ ...read('round-1023'), parentTaskId: 'round-0' });
  expect(inputAttachmentTaskScope(last, read, previous)).toHaveLength(1024);
  expect(() => inputAttachmentTaskScope(read('round-1024'), read, previous)).toThrow('关联异常');
  expect(() =>
    inputAttachmentTaskScope(read('round-1'), read, (task) =>
      task.id === 'round-1' ? 'round-0' : 'round-1',
    ),
  ).toThrow('关联异常');
  tasks.set('round-0', TaskSchema.parse({ ...read('round-0'), projectId: 'other' }));
  expect(() => inputAttachmentTaskScope(read('round-1'), read, previous)).toThrow('当前项目');
  expect(() =>
    inputAttachmentTaskScope(
      TaskSchema.parse({ ...read('round-1'), dependencyIds: ['round-0'] }),
      read,
    ),
  ).toThrow('当前项目');
});

it('reads legacy predecessor-only input links and isolates unrelated malformed conversation links', async () => {
  const root = fixture(),
    storage = openSqliteStorage({ filename: ':memory:' });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  try {
    runtime.createProject({ id: 'p', name: 'Legacy input links' });
    for (const id of ['original', 'next', 'unrelated'])
      runtime.taskEngine.createTask({
        id,
        projectId: 'p',
        title: id,
        objective: 'References',
        state: 'ready',
      });
    const attachment = runtime.inputAttachments.upload(
      'legacy.txt',
      'text/plain',
      Buffer.from('Legacy bytes'),
    );
    runtime.inputAttachments.repository.bind('original', 'original', [attachment.id]);
    for (const [taskId, sourceTaskId] of [
      ['next', 'original'],
      ['unrelated', 17],
    ] as const)
      storage.repositories.events.append({
        id: 'link-' + taskId,
        projectId: 'p',
        taskId,
        type: 'task.followup.created',
        actor: { type: 'system', id: 'fixture' },
        payload: { sourceTaskId },
        occurredAt: '2026-10-25T00:00:00Z',
      });
    expect(runtime.taskInputAttachments('original').map((a) => a.id)).toEqual([attachment.id]);
    expect(runtime.taskInputAttachments('next').map((a) => a.id)).toEqual([attachment.id]);
    expect(() => runtime.taskInputAttachments('unrelated')).toThrow();
  } finally {
    await runtime.close();
    storage.close();
    cleanup(root);
  }
});
