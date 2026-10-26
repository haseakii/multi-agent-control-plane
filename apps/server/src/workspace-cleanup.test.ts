import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

const hash = (value: string, length: number) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);
it('cleans a merged task snapshot and safe refs while preserving durable history across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-workflow-')),
    filename = join(root, 'state.sqlite');
  let storage = openSqliteStorage({ filename });
  const options = () => ({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  let runtime = createControlPlaneRuntime(options()),
    app = buildServer({ taskControl: runtime });
  try {
    runtime.createProject({ id: 'p', name: 'Cleanup workflow' });
    const source = storage.repositories.workspaces.get(
      storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId,
    )!;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    git(source.rootPath, 'init', '-b', 'main');
    git(source.rootPath, 'config', 'core.autocrlf', 'false');
    git(source.rootPath, 'config', 'user.name', 'Cleanup Test');
    git(source.rootPath, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source.rootPath, 'tracked.txt'), 'before\n');
    writeFileSync(join(source.rootPath, '.gitignore'), 'ignored.bin\n');
    git(source.rootPath, 'add', '.');
    git(source.rootPath, 'commit', '-m', 'Base');
    const base = git(source.rootPath, 'rev-parse', 'HEAD'),
      workspaceId = 'assignment-workspace-' + hash('a', 32);
    const work = join(root, 'workspaces', 'assignments', hash('p', 16), workspaceId),
      branch = 'codex/task-' + hash('a', 32);
    mkdirSync(resolve(work, '..'), { recursive: true });
    git(source.rootPath, 'worktree', 'add', '-b', branch, work, base);
    runtime.taskEngine.createTask({
      id: 't',
      projectId: 'p',
      title: 'Completed task',
      objective: 'Preserve changes',
      state: 'completed',
    });
    const at = new Date().toISOString();
    storage.repositories.assignments.upsert({
      id: 'a',
      taskId: 't',
      agentId: 'worker',
      objective: 'Changes',
      state: 'completed',
      attempt: 1,
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.workspaces.upsert({
      id: workspaceId,
      projectId: 'p',
      provider: 'git-worktree',
      rootPath: work,
      repositoryId: source.rootPath,
      branchName: branch,
      baseRevision: base,
      access: 'read-write',
    });
    storage.repositories.assignmentWorkspaces.upsert({
      id: 'a',
      projectId: 'p',
      taskId: 't',
      workspaceId,
      sourceWorkspaceId: source.id,
      mode: 'git-worktree',
      createdAt: at,
    });
    writeFileSync(join(work, 'tracked.txt'), 'delivered\n');
    git(work, 'add', 'tracked.txt');
    writeFileSync(join(work, 'new.txt'), 'deliverable\n');
    const cleanup = '/api/tasks/t/workspace-cleanup';
    expect((await app.inject({ method: 'GET', url: cleanup })).json().eligible).toBe(false);
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/t/workspace-reviews',
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(201);
    const review = response.json();
    const reviewPath = '/api/tasks/t/workspace-reviews/' + review.id;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: reviewPath + '/decision',
          payload: { state: 'approved' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: reviewPath + '/merge',
          payload: {
            confirmedTargetBranch: review.targetBranch,
            confirmedMergeCommit: review.mergeCommit,
          },
        })
      ).statusCode,
    ).toBe(200);
    const previewResponse = await app.inject({ method: 'GET', url: cleanup }),
      preview = previewResponse.json();
    expect(preview.eligible, previewResponse.body).toBe(true);
    expect(preview.plan.removeBranch).toBe(true);
    expect(preview.plan.refs).toHaveLength(1);
    const confirmation = {
      confirmedWorkspaceId: workspaceId,
      confirmationHash: preview.confirmationHash,
    };
    writeFileSync(join(work, 'ignored.bin'), 'must survive');
    expect(
      (await app.inject({ method: 'POST', url: cleanup, payload: confirmation })).statusCode,
    ).toBe(409);
    expect(readFileSync(join(work, 'ignored.bin'), 'utf8')).toBe('must survive');
    // Test-owned file only: clearing a blocker is an explicit operator action.
    rmSync(join(work, 'ignored.bin'));
    writeFileSync(join(work, 'new.txt'), 'unreviewed later change\n');
    expect(
      (await app.inject({ method: 'POST', url: cleanup, payload: confirmation })).statusCode,
    ).toBe(409);
    writeFileSync(join(work, 'new.txt'), 'deliverable\n');
    const result = await app.inject({ method: 'POST', url: cleanup, payload: confirmation });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().state).toBe('completed');
    expect(existsSync(work)).toBe(false);
    expect(
      git(source.rootPath, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + branch),
    ).toBe('');
    expect(
      git(
        source.rootPath,
        'for-each-ref',
        '--format=%(refname)',
        'refs/control-plane/reviews/' + review.id,
      ),
    ).toBe('');
    expect(readFileSync(join(source.rootPath, 'new.txt'), 'utf8')).toBe('deliverable\n');
    expect((await runtime.loadArtifact(review.patchArtifactId)).content.length).toBeGreaterThan(0);
    expect(storage.repositories.assignmentWorkspaces.get('a')?.workspaceId).toBe(workspaceId);
    // Simulate interruption after Git removal but before the final SQLite acknowledgement.
    storage.repositories.workspaceCleanups.upsert({
      ...storage.repositories.workspaceCleanups.get(workspaceId)!,
      state: 'removing',
    });
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    expect(storage.repositories.workspaceCleanups.get(workspaceId)?.state).toBe('removing');
    const recovered = await app.inject({
      method: 'POST',
      url: cleanup + '/check',
      payload: confirmation,
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().state).toBe('completed');
    expect((await app.inject({ method: 'GET', url: cleanup })).json().record.state).toBe(
      'completed',
    );
    expect(storage.repositories.tasks.get('t')?.state).toBe('completed');
    expect(storage.repositories.workspaceReviews.get(review.id)?.state).toBe('merged');
    expect(
      storage.repositories.events
        .listByProject('p')
        .some((e) => e.type === 'workspace.cleanup.completed'),
    ).toBe(true);
  } finally {
    await runtime.close();
    await app.close();
    if (storage.sqlite.open) storage.close();
    const target = resolve(root);
    if (!relative(resolve(tmpdir()), target).startsWith('cleanup-workflow-'))
      throw Error('Unexpected cleanup fixture root');
    rmSync(target, { recursive: true, force: true });
  }
}, 30000);

it('removes only empty task-local directories and preserves their binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-empty-')),
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({ storage, workspaceRoot: join(root, 'workspaces') }),
    app = buildServer({ taskControl: runtime });
  try {
    runtime.createProject({ id: 'p', name: 'Empty workspace' });
    runtime.taskEngine.createTask({
      id: 't',
      projectId: 'p',
      title: 'Empty task',
      objective: 'Done',
      state: 'completed',
    });
    const at = new Date().toISOString(),
      source = storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId;
    const workspaceId = 'assignment-workspace-' + hash('a', 32),
      work = join(root, 'workspaces', 'assignments', hash('p', 16), workspaceId);
    mkdirSync(work, { recursive: true });
    storage.repositories.assignments.upsert({
      id: 'a',
      taskId: 't',
      agentId: 'worker',
      objective: 'Done',
      state: 'completed',
      attempt: 1,
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.workspaces.upsert({
      id: workspaceId,
      projectId: 'p',
      provider: 'local-directory',
      rootPath: work,
      access: 'read-write',
    });
    storage.repositories.assignmentWorkspaces.upsert({
      id: 'a',
      projectId: 'p',
      taskId: 't',
      workspaceId,
      sourceWorkspaceId: source,
      mode: 'task-local',
      createdAt: at,
    });
    const url = '/api/tasks/t/workspace-cleanup';
    const preview = (await app.inject({ method: 'GET', url })).json();
    expect(preview.eligible).toBe(true);
    writeFileSync(join(work, 'result.txt'), 'keep me');
    const payload = {
      confirmedWorkspaceId: workspaceId,
      confirmationHash: preview.confirmationHash,
    };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(409);
    expect(existsSync(join(work, 'result.txt'))).toBe(true);
    rmSync(join(work, 'result.txt'));
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(200);
    expect(existsSync(work)).toBe(false);
    expect(storage.repositories.workspaces.get(workspaceId)).toBeDefined();
  } finally {
    await runtime.close();
    await app.close();
    storage.close();
    const target = resolve(root);
    if (!relative(resolve(tmpdir()), target).startsWith('cleanup-empty-'))
      throw Error('Unexpected fixture');
    rmSync(target, { recursive: true, force: true });
  }
});
