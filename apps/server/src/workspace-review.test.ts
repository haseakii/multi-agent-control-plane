import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  openSqliteStorage,
  createConsistentSqliteSnapshot,
  inspectSqliteSnapshot,
} from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

it('reviews, merges, and pushes the approved snapshot to a local bare remote across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-workflow-')),
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
    runtime.createProject({ id: 'p', name: 'Review workflow' });
    const source = storage.repositories.workspaces.get(
      storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId,
    )!;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    git(source.rootPath, 'init', '-b', 'main');
    git(source.rootPath, 'config', 'core.autocrlf', 'false');
    git(source.rootPath, 'config', 'user.name', 'Review Test');
    git(source.rootPath, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source.rootPath, 'tracked.txt'), 'before\n');
    git(source.rootPath, 'add', '.');
    git(source.rootPath, 'commit', '-m', 'Base');
    const base = git(source.rootPath, 'rev-parse', 'HEAD'),
      work = join(root, 'task');
    git(source.rootPath, 'worktree', 'add', '-b', 'codex/review-test', work, base);
    runtime.taskEngine.createTask({
      id: 't',
      projectId: 'p',
      title: 'Implement output',
      objective: 'Changes',
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
      id: 'w',
      projectId: 'p',
      provider: 'git-worktree',
      rootPath: work,
      repositoryId: source.rootPath,
      branchName: 'codex/review-test',
      baseRevision: base,
      access: 'read-write',
    });
    storage.repositories.assignmentWorkspaces.upsert({
      id: 'a',
      projectId: 'p',
      taskId: 't',
      workspaceId: 'w',
      sourceWorkspaceId: source.id,
      mode: 'git-worktree',
      createdAt: at,
    });
    writeFileSync(join(work, 'tracked.txt'), 'reviewed change\n');
    git(work, 'add', 'tracked.txt');
    writeFileSync(join(work, 'new.txt'), 'new deliverable\n');
    const index = git(work, 'diff', '--cached');
    const live = await app.inject({
      method: 'GET',
      url: '/api/tasks/t/live-changes?path=tracked.txt',
    });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.headers['cache-control']).toBe('no-store');
    expect(live.json().detail).toEqual({
      path: 'tracked.txt',
      before: 'before\n',
      after: 'reviewed change\n',
    });
    expect(storage.repositories.workspaceReviews.list()).toHaveLength(0);
    const concurrentReads = await Promise.all(
      ['tracked.txt', 'new.txt'].map((path) =>
        app.inject({ method: 'GET', url: `/api/tasks/t/live-changes?path=${path}` }),
      ),
    );
    expect(concurrentReads.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(concurrentReads.map((response) => response.json().detail.path)).toEqual([
      'tracked.txt',
      'new.txt',
    ]);
    expect(git(work, 'diff', '--cached')).toBe(index);
    expect(
      (await app.inject({ method: 'GET', url: '/api/tasks/t/live-changes?path=..%2Foutside.txt' }))
        .statusCode,
    ).toBe(409);
    writeFileSync(join(source.rootPath, 'other.txt'), 'another completed task\n');
    git(source.rootPath, 'add', '.');
    git(source.rootPath, 'commit', '-m', 'Other task');
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/tasks/t/workspace-reviews',
      payload: {},
    });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const review = prepared.json();
    expect(review.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'new.txt', status: 'A' }),
        expect.objectContaining({ path: 'tracked.txt', status: 'M' }),
      ]),
    );
    expect(git(work, 'diff', '--cached')).toBe(index);
    const patch = new TextDecoder().decode(
      (await runtime.loadArtifact(review.patchArtifactId)).content,
    );
    expect(patch).toContain('+new deliverable');
    const url = '/api/tasks/t/workspace-reviews/' + review.id;
    const confirmation = {
      confirmedTargetBranch: review.targetBranch,
      confirmedMergeCommit: review.mergeCommit,
    };
    expect(
      (await app.inject({ method: 'POST', url: url + '/merge', payload: confirmation })).statusCode,
    ).toBe(409);
    // Pending human review is durable too. A copied, unbound approval is not.
    storage.repositories.approvals.upsert({
      ...storage.repositories.approvals.get(review.approvalId)!,
      id: 'unbound-review-approval',
    });
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    expect(storage.repositories.approvals.get(review.approvalId)?.state).toBe('pending');
    expect(storage.repositories.approvals.get('unbound-review-approval')?.state).toBe('expired');
    expect(runtime.listWorkspaceReviews('t')[0]?.review.id).toBe(review.id);
    expect(
      (await app.inject({ method: 'POST', url: url + '/merge', payload: confirmation })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: url + '/decision', payload: { state: 'approved' } }))
        .statusCode,
    ).toBe(200);
    // Later edits cannot silently enter an already-approved snapshot.
    writeFileSync(join(work, 'new.txt'), 'later unreviewed edit\n');
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    const merged = await app.inject({ method: 'POST', url: url + '/merge', payload: confirmation });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().state).toBe('merged');
    expect(git(source.rootPath, 'rev-parse', 'HEAD')).toBe(review.mergeCommit);
    expect(readFileSync(join(source.rootPath, 'new.txt'), 'utf8')).toBe('new deliverable\n');
    expect(readFileSync(join(source.rootPath, 'other.txt'), 'utf8')).toBe(
      'another completed task\n',
    );
    expect(readFileSync(join(work, 'new.txt'), 'utf8')).toBe('later unreviewed edit\n');
    expect(git(source.rootPath, 'status', '--porcelain')).toBe('');
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    git(source.rootPath, 'remote', 'add', 'origin', remote);
    // A later local commit is deliberately excluded from this push request.
    writeFileSync(join(source.rootPath, 'later.txt'), 'not in reviewed push\n');
    git(source.rootPath, 'add', '.');
    git(source.rootPath, 'commit', '-m', 'Later work');
    const pushUrl = url + '/pushes';
    expect(
      (await app.inject({ method: 'POST', url: pushUrl, payload: { remote: 'origin' } }))
        .statusCode,
    ).toBe(409);
    runtime.setProjectPolicy('p', {
      expectedRevision: 0,
      tools: {},
      gitMerge: 'ask',
      gitPush: 'ask',
      requireEnforcedExecution: false,
    });
    const requested = await app.inject({
      method: 'POST',
      url: pushUrl,
      payload: { remote: 'origin' },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const push = requested.json(),
      pushPath = '/api/tasks/t/workspace-pushes/' + push.id;
    const pushConfirmation = {
      confirmedCommit: push.commit,
      confirmedDestinationHash: push.destinationHash,
    };
    expect(push.commit).toBe(review.mergeCommit);
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    expect(storage.repositories.approvals.get(push.approvalId)?.state).toBe('pending');
    expect(
      (await app.inject({ method: 'POST', url: pushPath + '/execute', payload: pushConfirmation }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: pushPath + '/decision',
          payload: { state: 'approved' },
        })
      ).statusCode,
    ).toBe(200);
    // Current policy still controls execution even after approval.
    runtime.setProjectPolicy('p', {
      expectedRevision: 1,
      tools: {},
      gitMerge: 'ask',
      gitPush: 'deny',
      requireEnforcedExecution: false,
    });
    expect(
      (await app.inject({ method: 'POST', url: pushPath + '/execute', payload: pushConfirmation }))
        .statusCode,
    ).toBe(409);
    runtime.setProjectPolicy('p', {
      expectedRevision: 2,
      tools: {},
      gitMerge: 'ask',
      gitPush: 'ask',
      requireEnforcedExecution: false,
    });
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    const pushed = await app.inject({
      method: 'POST',
      url: pushPath + '/execute',
      payload: pushConfirmation,
    });
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json().state).toBe('pushed');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(review.mergeCommit);
    expect(
      storage.repositories.events
        .listByProject('p')
        .filter((event) => event.type === 'workspace.push.pushed'),
    ).toHaveLength(1);
    // A repeated operator request reports the saved outcome without another push.
    expect(
      (
        await app.inject({ method: 'POST', url: pushPath + '/execute', payload: pushConfirmation })
      ).json().state,
    ).toBe('pushed');
    expect(
      storage.repositories.events
        .listByProject('p')
        .filter((event) => event.type === 'workspace.push.started'),
    ).toHaveLength(1);
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    expect(runtime.listWorkspacePushes('t')[0]?.push.state).toBe('pushed');
    await runtime.close();
    await app.close();
    storage.close();
    await createConsistentSqliteSnapshot(filename, join(root, 'backup.sqlite'));
    expect(inspectSqliteSnapshot(join(root, 'backup.sqlite')).migrations).toHaveLength(16);
  } finally {
    if (storage.sqlite.open) await runtime.close();
    await app.close();
    if (storage.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
