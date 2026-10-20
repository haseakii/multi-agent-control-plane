import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '@control-plane/storage';
import {
  ApprovalService,
  PolicyDeniedError,
  PolicyEngine,
  PolicyGate,
  SqliteApprovalStore,
} from '@control-plane/policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitWorktreeWorkspaceProvider,
  LocalDirectoryWorkspaceProvider,
  type GitExecutor,
} from './index.js';

const directories: string[] = [];
let sequence = 0;

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function policy(
  storage: ReturnType<typeof openSqliteStorage>,
  rules: ConstructorParameters<typeof PolicyEngine>[0]['rules'],
) {
  const approvals = new ApprovalService(new SqliteApprovalStore(storage), {
    now: () => '2026-10-20T03:30:00.000Z',
    idFactory: () => `approval-${++sequence}`,
  });
  return new PolicyGate(new PolicyEngine({ rules, defaultEffect: 'deny' }), approvals);
}

function initRepository(): string {
  const repository = tempDirectory('control-plane-workspace-repo-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Control Plane Tests'], { cwd: repository });
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository });
  return repository;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('workspace policy boundary', () => {
  it('fails closed when strict LocalDirectory isolation is required', async () => {
    const directory = tempDirectory('control-plane-local-workspace-');
    const storage = openSqliteStorage({ filename: join(directory, 'storage.sqlite') });
    const root = join(directory, 'workspace');
    mkdirSync(root);
    const provider = new LocalDirectoryWorkspaceProvider(
      storage,
      policy(storage, [{ id: 'allow-read', actionPattern: 'workspace.read', effect: 'allow' }]),
      () => 'workspace-local',
    );

    await expect(
      provider.create({
        projectId: 'project-workspace',
        rootPath: root,
        access: 'read-only',
        requiresEnforcedBoundary: true,
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    storage.close();
  });

  it('creates isolated Git worktrees for two write tasks', async () => {
    const repository = initRepository();
    const state = tempDirectory('control-plane-workspace-state-');
    const storage = openSqliteStorage({ filename: join(state, 'storage.sqlite') });
    const provider = new GitWorktreeWorkspaceProvider(
      storage,
      policy(storage, [{ id: 'allow-write', actionPattern: 'workspace.write', effect: 'allow' }]),
      () => `workspace-${++sequence}`,
    );
    const root = join(state, 'worktrees');

    const first = await provider.create({
      id: 'workspace-a',
      projectId: 'project-workspace',
      taskId: 'task-a',
      repositoryPath: repository,
      worktreeRoot: root,
      baseRef: 'main',
      branchName: 'task/a',
    });
    const second = await provider.create({
      id: 'workspace-b',
      projectId: 'project-workspace',
      taskId: 'task-b',
      repositoryPath: repository,
      worktreeRoot: root,
      baseRef: 'main',
      branchName: 'task/b',
    });

    expect(first.rootPath).not.toBe(second.rootPath);
    expect(first.branchName).toBe('task/a');
    expect(second.branchName).toBe('task/b');
    expect(storage.repositories.workspaces.list()).toHaveLength(2);
    storage.close();
  });

  it('does not invoke Git push when policy denies it, regardless of agent instructions', async () => {
    const repository = initRepository();
    const state = tempDirectory('control-plane-workspace-deny-');
    const storage = openSqliteStorage({ filename: join(state, 'storage.sqlite') });
    storage.repositories.workspaces.upsert({
      id: 'workspace-denied',
      projectId: 'project-workspace',
      provider: 'git-worktree',
      rootPath: join(state, 'worktree'),
      access: 'read-write',
      repositoryId: repository,
      baseRevision: 'main',
      branchName: 'task/denied',
    });
    const git: GitExecutor = { run: vi.fn(async () => '') };
    const provider = new GitWorktreeWorkspaceProvider(
      storage,
      policy(storage, [{ id: 'deny-push', actionPattern: 'git.push', effect: 'deny' }]),
      () => 'unused',
      git,
    );

    await expect(
      provider.push({
        workspaceId: 'workspace-denied',
        requesterAgentId: 'agent-boss',
        remote: 'origin',
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(git.run).not.toHaveBeenCalled();
    storage.close();
  });
});
