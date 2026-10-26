import { mkdir, realpath, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { WorkspaceIdSchema, WorkspaceSchema } from '@control-plane/core';
import type { Workspace } from '@control-plane/core';
import type { PolicyGate } from '@control-plane/policy';
import type { SqliteStorage } from '@control-plane/storage';
import { NodeGitExecutor } from './git-executor.js';
import {
  GitMergeInputSchema,
  GitPushInputSchema,
  GitWorktreeCreateInputSchema,
  type GitExecutor,
  type GitMergeInput,
  type GitPushInput,
  type GitWorktreeCreateInput,
  type WorkspaceIdFactory,
} from './types.js';

function assertSafeRef(value: string): void {
  if (
    value.startsWith('-') ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new TypeError(`Unsafe Git ref: ${value}`);
  }
}

export class GitWorktreeWorkspaceProvider {
  constructor(
    private readonly storage: SqliteStorage,
    private readonly policy: PolicyGate,
    private readonly idFactory: WorkspaceIdFactory,
    private readonly git: GitExecutor = new NodeGitExecutor(),
  ) {}

  async create(input: GitWorktreeCreateInput): Promise<Workspace> {
    const parsed = GitWorktreeCreateInputSchema.parse(input);
    assertSafeRef(parsed.baseRef);
    assertSafeRef(parsed.branchName);
    const repositoryPath = await realpath(resolve(parsed.repositoryPath));
    const worktreeRoot = resolve(parsed.worktreeRoot);
    await mkdir(worktreeRoot, { recursive: true });
    const id = parsed.id ?? WorkspaceIdSchema.parse(this.idFactory());
    const targetPath = resolve(worktreeRoot, id);

    if (
      targetPath === worktreeRoot ||
      (!targetPath.startsWith(`${worktreeRoot}/`) && !targetPath.startsWith(`${worktreeRoot}\\`))
    ) {
      throw new TypeError('Worktree target must remain under the configured worktree root.');
    }

    return this.policy.run(
      {
        projectId: parsed.projectId,
        taskId: parsed.taskId,
        requesterAgentId: parsed.requesterAgentId,
        action: 'workspace.write',
        resource: {
          provider: 'git-worktree',
          repositoryPath,
          targetPath,
          baseRef: parsed.baseRef,
          branchName: parsed.branchName,
        },
        enforcementMode: 'unavailable',
        boundary: 'git-worktree',
        requiresEnforcedBoundary: parsed.requiresEnforcedBoundary,
      },
      async () => {
        await this.git.run(repositoryPath, ['check-ref-format', '--branch', parsed.branchName]);
        await this.git.run(repositoryPath, [
          'worktree',
          'add',
          '-b',
          parsed.branchName,
          targetPath,
          parsed.baseRef,
        ]);
        try {
          const workspace = WorkspaceSchema.parse({
            id,
            projectId: parsed.projectId,
            provider: 'git-worktree',
            rootPath: targetPath,
            access: 'read-write',
            repositoryId: repositoryPath,
            baseRevision: parsed.reviewBaseRevision ?? parsed.baseRef,
            branchName: parsed.branchName,
          });
          return this.storage.repositories.workspaces.upsert(workspace);
        } catch (error) {
          await this.git
            .run(repositoryPath, ['worktree', 'remove', '--force', targetPath])
            .catch(() => undefined);
          await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      },
    );
  }

  async remove(workspaceId: string): Promise<void> {
    const workspace = this.requireGitWorkspace(workspaceId);
    await this.git.run(workspace.repositoryId!, [
      'worktree',
      'remove',
      '--force',
      workspace.rootPath,
    ]);
    this.storage.repositories.workspaces.delete(workspace.id);
  }

  async merge(input: GitMergeInput): Promise<void> {
    const parsed = GitMergeInputSchema.parse(input);
    assertSafeRef(parsed.targetRef);
    const workspace = this.requireGitWorkspace(parsed.workspaceId);
    await this.policy.run(
      {
        projectId: workspace.projectId,
        taskId: parsed.taskId,
        requesterAgentId: parsed.requesterAgentId,
        action: 'git.merge',
        resource: {
          repositoryPath: workspace.repositoryId!,
          sourceBranch: workspace.branchName!,
          targetRef: parsed.targetRef,
        },
        enforcementMode: 'enforced',
        boundary: 'control-plane-git',
      },
      async () => {
        const current = await this.git.run(workspace.repositoryId!, ['branch', '--show-current']);
        if (current !== parsed.targetRef) {
          throw new Error(
            `Repository must be on target branch ${parsed.targetRef} before merge; current branch is ${current || '<detached>'}.`,
          );
        }
        await this.git.run(workspace.repositoryId!, [
          'merge',
          '--no-ff',
          '--no-edit',
          workspace.branchName!,
        ]);
      },
    );
  }

  async push(input: GitPushInput): Promise<void> {
    const parsed = GitPushInputSchema.parse(input);
    const workspace = this.requireGitWorkspace(parsed.workspaceId);
    await this.policy.run(
      {
        projectId: workspace.projectId,
        taskId: parsed.taskId,
        requesterAgentId: parsed.requesterAgentId,
        action: 'git.push',
        resource: {
          repositoryPath: workspace.repositoryId!,
          remote: parsed.remote,
          branchName: workspace.branchName!,
        },
        enforcementMode: 'enforced',
        boundary: 'control-plane-git',
      },
      () => this.git.run(workspace.repositoryId!, ['push', parsed.remote, workspace.branchName!]),
    );
  }

  private requireGitWorkspace(id: string): Workspace {
    const workspaceId = WorkspaceIdSchema.parse(id);
    const workspace = this.storage.repositories.workspaces.get(workspaceId);
    if (!workspace || workspace.provider !== 'git-worktree') {
      throw new Error(`Git worktree workspace not found: ${id}`);
    }
    if (!workspace.repositoryId || !workspace.branchName) {
      throw new Error(`Git worktree workspace is missing repository metadata: ${id}`);
    }
    return workspace;
  }
}
