import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
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
      n: 20,
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
    const captured = await new LocalGitReviewAdapter().capture({
      id: 'w',
      projectId: 'p',
      provider: 'git-worktree',
      rootPath: root,
      baseRevision,
      access: 'read-write',
    });
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
    const child = { ...first.task, id: 'child', parentTaskId: first.task.id, dependencyIds: [] };
    const childScope = inputAttachmentTaskScope(child, (id) => runtime.getTask(id));
    expect(childScope).toContain(first.task.id);
    expect(() =>
      inputAttachmentTaskScope(child, () => ({ ...first.task, projectId: 'other' })),
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
