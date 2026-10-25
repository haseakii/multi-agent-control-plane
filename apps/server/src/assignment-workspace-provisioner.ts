import { createHash } from 'node:crypto';
import { copyFile, mkdir, realpath, stat, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  WorkspaceSchema,
  AuditEventSchema,
  type Assignment,
  type ProjectWorkspaceConfig,
  type Task,
  type Workspace,
} from '@control-plane/core';
import {
  GitWorktreeWorkspaceProvider,
  NodeGitExecutor,
  LocalGitReviewAdapter,
  type AssignmentWorkspaceProvisioner,
} from '@control-plane/workspace';
import type { SqliteStorage } from '@control-plane/storage';
import type { PolicyGate } from '@control-plane/policy';
import { readWorkspacePage } from './workspace-page.js';
import { LocalWorkspacePreviewFiles } from './workspace-preview-files.js';

export class LocalAssignmentWorkspaceProvisioner implements AssignmentWorkspaceProvisioner {
  private readonly git = new NodeGitExecutor();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly root: string,
    private readonly policy: PolicyGate,
  ) {}

  async create(
    assignment: Assignment,
    task: Task,
    config: ProjectWorkspaceConfig,
    source: Workspace,
  ): Promise<Workspace> {
    const key = createHash('sha256').update(assignment.id).digest('hex').slice(0, 32);
    const workspaceId = 'assignment-workspace-' + key;
    // A workspace committed immediately before a process interruption is reused.
    const previous = this.storage.repositories.workspaces.get(workspaceId);
    if (previous) return previous;
    const projectKey = createHash('sha256').update(task.projectId).digest('hex').slice(0, 16);
    const worktreeRoot = join(this.root, 'assignments', projectKey);
    const link = this.storage.repositories.events
      .listByProject(task.projectId)
      .find((e) => e.taskId === task.id && e.type === 'task.followup.created');
    const previousBinding =
      typeof link?.payload.sourceTaskId === 'string'
        ? this.storage.repositories.assignmentWorkspaces
            .list()
            .filter((b) => b.taskId === link.payload.sourceTaskId)
            .at(-1)
        : undefined;
    let continued: Workspace | undefined;
    if (previousBinding) {
      if (previousBinding.sourceWorkspaceId !== source.id || previousBinding.mode !== config.mode)
        throw new Error(
          'Previous round uses a different project workspace; restore its mode before continuing.',
        );
      const cleaned = this.storage.repositories.workspaceCleanups.get(previousBinding.workspaceId);
      if (cleaned) {
        if (
          !this.storage.repositories.workspaceReviews
            .list()
            .some((r) => r.taskId === previousBinding.taskId && r.state === 'merged')
        )
          throw new Error('Previous unmerged workspace is no longer available.');
      } else {
        continued = this.storage.repositories.workspaces.get(previousBinding.workspaceId);
        if (!continued) throw new Error('Previous workspace is unavailable.');
        await this.validate(continued);
      }
    }
    const recordContinuation = (workspace: Workspace, revision?: string) => {
      if (continued)
        this.storage.repositories.events.append(
          AuditEventSchema.parse({
            id: 'continuation-' + key,
            projectId: task.projectId,
            taskId: task.id,
            assignmentId: assignment.id,
            type: 'workspace.continued',
            actor: { type: 'system', id: 'workspace-provisioner' },
            payload: {
              sourceTaskId: previousBinding!.taskId,
              previousWorkspaceId: continued.id,
              workspaceId: workspace.id,
              ...(revision ? { snapshotRevision: revision } : {}),
              sourceUnchanged: true,
            },
            occurredAt: new Date().toISOString(),
          }),
        );
      return workspace;
    };
    if (config.mode === 'git-worktree') {
      const baseRevision = await this.git.run(source.rootPath, [
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ]);
      const continuation = continued
        ? await new LocalGitReviewAdapter(this.git).continueSnapshot(continued, source, key)
        : undefined;
      const workspace = await new GitWorktreeWorkspaceProvider(
        this.storage,
        this.policy,
        () => workspaceId,
        this.git,
      ).create({
        id: workspaceId,
        projectId: task.projectId,
        taskId: task.id,
        requesterAgentId: assignment.agentId,
        repositoryPath: source.rootPath,
        worktreeRoot,
        baseRef: continuation?.commit ?? baseRevision,
        reviewBaseRevision: continuation?.reviewBaseRevision ?? baseRevision,
        branchName: 'codex/task-' + key,
      });
      return recordContinuation(workspace, continuation?.commit);
    }
    if (config.mode !== 'task-local') throw new Error('Unsupported workspace provisioning mode.');
    const rootPath = join(worktreeRoot, workspaceId);
    await mkdir(rootPath, { recursive: true });
    if (continued) await copyTaskFiles(continued.rootPath, rootPath);
    return recordContinuation(
      this.storage.repositories.workspaces.upsert(
        WorkspaceSchema.parse({
          id: workspaceId,
          projectId: task.projectId,
          provider: 'local-directory',
          rootPath,
          access: 'read-write',
        }),
      ),
    );
  }

  async validate(workspace: Workspace): Promise<void> {
    const root = await realpath(workspace.rootPath);
    const normalized = (value: string) =>
      process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
    if (normalized(root) !== normalized(workspace.rootPath) || !(await stat(root)).isDirectory())
      throw new Error('Assignment workspace is unavailable or has changed.');
  }

  async collectChanges(workspace: Workspace) {
    if (workspace.provider !== 'git-worktree' || !workspace.baseRevision) return undefined;
    const snapshot = await new LocalGitReviewAdapter(this.git).capture(workspace);
    const status = await this.git.run(workspace.rootPath, [
      'status',
      '--short',
      '--untracked-files=all',
    ]);
    return {
      ...snapshot,
      status,
      note: 'Snapshot includes tracked and non-ignored untracked files, preserving the real Git index. Ignored files and submodule working-tree contents are not included. No merge or push was performed.',
    };
  }
  async readPage(workspace: Workspace) {
    await this.validate(workspace);
    return readWorkspacePage(workspace.rootPath);
  }
  previewFiles(workspace: Workspace, validate: () => Promise<void>) {
    return new LocalWorkspacePreviewFiles(workspace.rootPath, validate);
  }
}

async function copyTaskFiles(source: string, destination: string) {
  // Task-local rounds carry ordinary project files, not credentials, caches or link targets.
  const skip = new Set([
    '.git',
    'node_modules',
    '.env',
    '.codex',
    '.aws',
    '.ssh',
    '.cache',
    '.control-plane-inputs',
  ]);
  const files: string[] = [],
    directories: string[] = [];
  let bytes = 0;
  async function walk(relative: string) {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('.env.')) continue;
      const path = join(relative, entry.name),
        info = await lstat(join(source, path));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new Error('Task continuation cannot copy symbolic links or special files.');
      if (
        files.length + directories.length >= 10_000 ||
        (bytes += info.isFile() ? info.size : 0) > 256 * 1024 * 1024
      )
        throw new Error(
          'Task continuation exceeds the local copy budget; use a Git project for larger work.',
        );
      if (info.isDirectory()) {
        directories.push(path);
        await walk(path);
      } else files.push(path);
    }
  }
  await walk('');
  for (const path of directories) await mkdir(join(destination, path), { recursive: true });
  for (const path of files) await copyFile(join(source, path), join(destination, path));
}
