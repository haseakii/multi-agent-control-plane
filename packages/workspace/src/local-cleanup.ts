import { createHash } from 'node:crypto';
import { lstat, realpath, readdir, rmdir } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import {
  WorkspaceCleanupPlanSchema,
  type AssignmentWorkspace,
  type Workspace,
  type WorkspaceReview,
  type WorkspaceCleanupPlan,
} from '@control-plane/core';
import { LocalGitReviewAdapter, WorkspaceReviewError } from './git-review.js';
import { NodeGitExecutor } from './git-executor.js';
import type { GitExecutor } from './types.js';
import type { WorkspaceCleanupAdapter } from './cleanup-service.js';

const same = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
const hash = (value: string, length: number) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);
export class LocalWorkspaceCleanupAdapter implements WorkspaceCleanupAdapter {
  constructor(
    private readonly managedRoot: string,
    private readonly git: GitExecutor = new NodeGitExecutor(),
  ) {}
  private async directory(path: string) {
    const canonical = await realpath(path),
      info = await lstat(path);
    if (!same(canonical, path) || !info.isDirectory() || info.isSymbolicLink())
      throw new WorkspaceReviewError('目录身份已变化，不能清理。');
    return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  }
  private async bounds(path: string) {
    const root = await realpath(this.managedRoot);
    const local = relative(root, resolve(path));
    if (
      !local ||
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..\\') ||
      local.startsWith('../')
    )
      throw new WorkspaceReviewError('目录不在控制平面管理范围内。');
    // Resolve ancestors even when the final directory was already removed.
    const parent = await realpath(resolve(path, '..'));
    if (!same(parent, resolve(path, '..')))
      throw new WorkspaceReviewError('工作区父目录已被重定向。');
  }
  private async worktrees(source: Workspace) {
    return (
      await this.git.run(source.rootPath, ['worktree', 'list', '--porcelain', '-z'], {
        trim: false,
      })
    )
      .split('\0\0')
      .filter(Boolean)
      .map((block) => {
        const fields = block.split('\0');
        return {
          path: fields.find((f) => f.startsWith('worktree '))?.slice(9),
          head: fields.find((f) => f.startsWith('HEAD '))?.slice(5),
          branch: fields.find((f) => f.startsWith('branch '))?.slice(7),
          locked: fields.some((f) => f.startsWith('locked')),
          prunable: fields.some((f) => f.startsWith('prunable')),
        };
      });
  }
  private async ancestor(source: Workspace, commit: string) {
    try {
      await this.git.run(source.rootPath, ['merge-base', '--is-ancestor', commit, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }
  async prepare(
    binding: AssignmentWorkspace,
    workspace: Workspace,
    source: Workspace,
    reviews: WorkspaceReview[],
  ): Promise<WorkspaceCleanupPlan> {
    const expectedId = 'assignment-workspace-' + hash(binding.id, 32);
    const expectedPath = join(
      this.managedRoot,
      'assignments',
      hash(binding.projectId, 16),
      expectedId,
    );
    if (
      workspace.id !== expectedId ||
      !same(workspace.rootPath, expectedPath) ||
      workspace.id === source.id
    )
      throw new WorkspaceReviewError('此目录不是当前规则创建的独立任务工作区，请人工管理。');
    await this.bounds(workspace.rootPath);
    const directoryIdentity = await this.directory(workspace.rootPath);
    const base = {
      workspaceId: workspace.id,
      sourceWorkspaceId: source.id,
      rootPath: workspace.rootPath,
      directoryIdentity,
      mode: binding.mode,
      removeBranch: false,
      refs: [],
      notes: [
        '清理后保留任务、消息和产物历史；此任务不再支持原地恢复。',
        '清理期间请暂停外部编辑器和 Git 写入；操作台只能阻止自身发起的并发执行。',
      ],
    };
    if (binding.mode === 'task-local') {
      if ((await readdir(workspace.rootPath)).length)
        throw new WorkspaceReviewError(
          '任务目录仍有文件，请先保存或移走所需内容；仅自动清理空目录。',
        );
      return WorkspaceCleanupPlanSchema.parse(base);
    }
    if (
      binding.mode !== 'git-worktree' ||
      !workspace.repositoryId ||
      !same(await realpath(workspace.repositoryId), await realpath(source.rootPath))
    )
      throw new WorkspaceReviewError('工作区与项目仓库不匹配。');
    const top = await this.git.run(source.rootPath, ['rev-parse', '--show-toplevel']);
    if (!same(top, source.rootPath)) throw new WorkspaceReviewError('项目目录不是仓库根目录。');
    const marker = await lstat(join(workspace.rootPath, '.git'));
    const sourceCommon = await this.git.run(source.rootPath, ['rev-parse', '--git-common-dir']);
    const taskCommon = await this.git.run(workspace.rootPath, ['rev-parse', '--git-common-dir']);
    if (
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      !same(
        await realpath(resolve(source.rootPath, sourceCommon)),
        await realpath(resolve(workspace.rootPath, taskCommon)),
      )
    )
      throw new WorkspaceReviewError('Git 工作区连接已变化，不能清理。');
    const entries = await this.worktrees(source),
      entry = entries.find((e) => e.path && same(e.path, workspace.rootPath));
    if (
      !entry ||
      entry.branch !== 'refs/heads/' + workspace.branchName ||
      entry.locked ||
      entry.prunable
    )
      throw new WorkspaceReviewError('工作区登记、分支或锁定状态不允许清理。');
    if (
      await this.git.run(workspace.rootPath, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
      ])
    )
      throw new WorkspaceReviewError('存在未纳入审阅快照的忽略文件，请先保存或移走。');
    const tracked = await this.git.run(workspace.rootPath, ['ls-files', '-v', '-z'], {
      trim: false,
    });
    if (
      tracked
        .split('\0')
        .filter(Boolean)
        .some((line) => !line.startsWith('H '))
    )
      throw new WorkspaceReviewError('存在稀疏、忽略变更或冲突的索引标记，不能确认文件已保留。');
    const snapshot = await new LocalGitReviewAdapter(this.git).capture(workspace);
    if (
      (await this.git.run(workspace.rootPath, ['ls-tree', '-r', snapshot.tree]))
        .split('\n')
        .some((line) => line.startsWith('160000 '))
    )
      throw new WorkspaceReviewError('子模块或嵌套仓库需要人工保存和清理。');
    const headTree = await this.git.run(workspace.rootPath, ['rev-parse', 'HEAD^{tree}']);
    const retainedEntries = new Set<string>();
    for (const tree of [headTree, snapshot.tree]) {
      const listing = await this.git.run(workspace.rootPath, ['ls-tree', '-r', '-z', tree], {
        trim: false,
      });
      for (const row of listing.split('\0').filter(Boolean)) {
        const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (match) retainedEntries.add(match[1] + ' ' + match[2] + '\t' + match[3]);
      }
    }
    const index = await this.git.run(workspace.rootPath, ['ls-files', '--stage', '-z'], {
      trim: false,
    });
    for (const row of index.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(row);
      if (!match || !retainedEntries.has(match[1] + ' ' + match[2] + '\t' + match[3]))
        throw new WorkspaceReviewError('索引含有独立暂存版本，请先保存该版本。');
    }
    const merged = [];
    for (const review of reviews.filter(
      (r) => r.workspaceId === workspace.id && r.state === 'merged',
    )) {
      if (await this.ancestor(source, review.mergeCommit)) merged.push(review);
    }
    let preserved =
      snapshot.tree === headTree && (await this.ancestor(source, snapshot.headRevision));
    for (const review of merged) {
      if (
        snapshot.tree ===
        (await this.git.run(source.rootPath, ['rev-parse', review.snapshotCommit + '^{tree}']))
      )
        preserved = true;
    }
    if (!preserved)
      throw new WorkspaceReviewError('当前文件内容尚未合并到项目当前分支，请先完成审阅合并。');
    const removeBranch = await this.ancestor(source, snapshot.headRevision);
    const refs: { name: string; commit: string }[] = [];
    for (const review of merged) {
      const name = 'refs/control-plane/reviews/' + review.id;
      const value = await this.git
        .run(source.rootPath, ['rev-parse', '--verify', name])
        .catch(() => undefined);
      if (value === review.mergeCommit) refs.push({ name, commit: value });
    }
    return WorkspaceCleanupPlanSchema.parse({
      ...base,
      head: snapshot.headRevision,
      tree: snapshot.tree,
      branch: workspace.branchName,
      removeBranch,
      refs,
      notes: [
        ...base.notes,
        ...(removeBranch
          ? ['任务分支已包含在项目当前分支中，将一并删除。']
          : ['任务分支包含独立提交历史，将保留该分支，仅清理工作区。']),
        '仅删除已合并且提交一致的审阅引用；其他审阅引用保留。',
      ],
    });
  }
  async exists(plan: WorkspaceCleanupPlan) {
    try {
      await lstat(plan.rootPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  async remove(plan: WorkspaceCleanupPlan, source: Workspace) {
    await this.bounds(plan.rootPath);
    if ((await this.directory(plan.rootPath)) !== plan.directoryIdentity)
      throw new WorkspaceReviewError('工作区目录已被替换。');
    if (plan.mode === 'task-local')
      await rmdir(plan.rootPath); // Empty directory only; never recursive.
    else await this.git.run(source.rootPath, ['worktree', 'remove', '--force', plan.rootPath]);
    await this.finish(plan, source);
  }
  async finish(plan: WorkspaceCleanupPlan, source: Workspace) {
    await this.bounds(plan.rootPath);
    if (await this.exists(plan)) throw new WorkspaceReviewError('工作区目录仍存在。');
    if (plan.mode === 'task-local') return;
    const entries = await this.worktrees(source);
    if (entries.some((e) => e.path && same(e.path, plan.rootPath)))
      throw new WorkspaceReviewError('Git 工作区登记仍存在。');
    const deletions = [...plan.refs];
    if (plan.removeBranch && plan.branch && plan.head) {
      if (entries.some((e) => e.branch === 'refs/heads/' + plan.branch))
        throw new WorkspaceReviewError('任务分支已被其他工作区使用。');
      deletions.push({ name: 'refs/heads/' + plan.branch, commit: plan.head });
    }
    for (const item of deletions) {
      const current = await this.git
        .run(source.rootPath, ['rev-parse', '--verify', item.name])
        .catch(() => undefined);
      if (!current) continue;
      if (current !== item.commit || !(await this.ancestor(source, current)))
        throw new WorkspaceReviewError('待清理引用已变化或不再包含于项目当前分支。');
      await this.git.run(source.rootPath, ['update-ref', '-d', item.name, item.commit]);
    }
  }
}
