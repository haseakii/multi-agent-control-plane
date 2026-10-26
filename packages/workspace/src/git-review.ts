import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import {
  GitObjectIdSchema,
  type Workspace,
  type WorkspaceReview,
  type WorkspaceChangeFile,
} from '@control-plane/core';
import { NodeGitExecutor } from './git-executor.js';
import type { GitExecutor } from './types.js';

export class WorkspaceReviewError extends Error {}
export type GitChangeSnapshot = {
  tree: string;
  patch: string;
  headRevision: string;
  baseRevision: string;
  files: WorkspaceChangeFile[];
  branchName?: string;
  rootPath: string;
};
export type PreparedWorkspaceReview = {
  baseRevision: string;
  workspaceHead: string;
  snapshotCommit: string;
  mergeCommit: string;
  targetHead: string;
  targetBranch: string;
  files: WorkspaceChangeFile[];
  patch: string;
};
export interface WorkspaceReviewAdapter {
  prepare(
    workspace: Workspace,
    target: Workspace,
    reviewId: string,
  ): Promise<PreparedWorkspaceReview>;
  apply(review: WorkspaceReview, target: Workspace): Promise<void>;
  isApplied(review: WorkspaceReview, target: Workspace): Promise<boolean>;
}
const objectId = (value: string) => GitObjectIdSchema.parse(value);
const identity = {
  GIT_AUTHOR_NAME: 'Control Plane',
  GIT_AUTHOR_EMAIL: 'control-plane@localhost',
  GIT_COMMITTER_NAME: 'Control Plane',
  GIT_COMMITTER_EMAIL: 'control-plane@localhost',
};
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/** Git objects and a private index capture tracked and untracked changes without staging the user's index. */
export class LocalGitReviewAdapter implements WorkspaceReviewAdapter {
  constructor(private readonly git: GitExecutor = new NodeGitExecutor()) {}

  private async temporary<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    const parent = resolve(tmpdir()),
      directory = await mkdtemp(join(parent, 'control-plane-review-'));
    try {
      return await operation(directory);
    } finally {
      if (
        dirname(resolve(directory)) !== parent ||
        !basename(directory).startsWith('control-plane-review-')
      )
        throw new Error('Unexpected private index directory.');
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async root(path: string) {
    const actual = await realpath(path);
    const top = await this.git.run(actual, ['rev-parse', '--show-toplevel']);
    if (!samePath(actual, path) || !samePath(top, actual))
      throw new WorkspaceReviewError('工作区必须仍指向已登记的 Git 仓库根目录。');
  }
  async capture(workspace: Workspace): Promise<GitChangeSnapshot> {
    if (workspace.provider !== 'git-worktree' || !workspace.baseRevision)
      throw new WorkspaceReviewError('此任务未使用独立 Git 工作区。');
    const baseRevision = objectId(workspace.baseRevision);
    await this.root(workspace.rootPath);
    return this.temporary(async (directory) => {
      const options = { env: { GIT_INDEX_FILE: join(directory, 'index') } };
      const headRevision = objectId(await this.git.run(workspace.rootPath, ['rev-parse', 'HEAD']));
      await this.git.run(workspace.rootPath, ['read-tree', 'HEAD'], options);
      await this.git.run(workspace.rootPath, ['add', '-A', '--', '.'], options);
      const tree = objectId(await this.git.run(workspace.rootPath, ['write-tree'], options));
      return {
        tree,
        headRevision,
        baseRevision,
        ...(workspace.branchName ? { branchName: workspace.branchName } : {}),
        rootPath: workspace.rootPath,
        patch: await this.patch(workspace.rootPath, baseRevision, tree),
        files: await this.files(workspace.rootPath, baseRevision, tree),
      };
    });
  }
  private patch(root: string, before: string, after: string) {
    return this.git.run(
      root,
      ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', before, after, '--'],
      { trim: false, maxBuffer: 64 * 1024 * 1024 },
    );
  }
  private async files(root: string, before: string, after: string): Promise<WorkspaceChangeFile[]> {
    const names = (
      await this.git.run(
        root,
        ['diff', '--name-status', '-z', '--no-renames', before, after, '--'],
        { trim: false },
      )
    ).split('\0');
    const status = new Map<string, WorkspaceChangeFile['status']>();
    for (let i = 0; i + 1 < names.length; i += 2)
      status.set(names[i + 1]!, names[i]! as WorkspaceChangeFile['status']);
    const stats = await this.git.run(
      root,
      ['diff', '--numstat', '-z', '--no-renames', before, after, '--'],
      { trim: false },
    );
    return stats
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const first = row.indexOf('\t'),
          second = row.indexOf('\t', first + 1);
        const added = row.slice(0, first),
          deleted = row.slice(first + 1, second),
          path = row.slice(second + 1);
        return {
          path,
          status: status.get(path)!,
          additions: added === '-' ? null : Number(added),
          deletions: deleted === '-' ? null : Number(deleted),
        };
      });
  }
  private async target(target: Workspace) {
    await this.root(target.rootPath);
    const branch = await this.git
      .run(target.rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      .catch(() => {
        throw new WorkspaceReviewError('项目目录处于 detached HEAD，请先选择目标分支。');
      });
    if (await this.git.run(target.rootPath, ['status', '--porcelain', '--untracked-files=all']))
      throw new WorkspaceReviewError(
        '目标项目目录有未提交或未跟踪文件，请先处理后再生成/合并审阅。',
      );
    return { branch, head: objectId(await this.git.run(target.rootPath, ['rev-parse', 'HEAD'])) };
  }
  /** Carry unfinished edits into a new round without modifying either existing checkout. */
  async continueSnapshot(workspace: Workspace, target: Workspace, continuationId: string) {
    if (!/^[a-f0-9]{32}$/.test(continuationId))
      throw new WorkspaceReviewError('Invalid continuation identity.');
    if (
      !workspace.repositoryId ||
      !samePath(await realpath(workspace.repositoryId), await realpath(target.rootPath))
    )
      throw new WorkspaceReviewError('Previous round belongs to a different source repository.');
    const destination = await this.target(target),
      snapshot = await this.capture(workspace);
    const snapshotCommit = objectId(
      await this.git.run(
        target.rootPath,
        [
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          snapshot.tree,
          '-p',
          snapshot.baseRevision,
          '-m',
          'Continuation snapshot ' + continuationId,
        ],
        { env: identity },
      ),
    );
    let tree: string;
    try {
      tree = objectId(
        (
          await this.git.run(target.rootPath, [
            'merge-tree',
            '--write-tree',
            destination.head,
            snapshotCommit,
          ])
        ).split('\n')[0]!,
      );
    } catch {
      throw new WorkspaceReviewError(
        '上一轮修改与当前项目版本冲突；已保留原工作区，请解决后再继续。',
      );
    }
    const commit = objectId(
      await this.git.run(
        target.rootPath,
        [
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          tree,
          '-p',
          destination.head,
          '-m',
          'Continue task ' + continuationId,
        ],
        { env: identity },
      ),
    );
    await this.git.run(target.rootPath, [
      'update-ref',
      'refs/control-plane/continuations/' + continuationId,
      commit,
    ]);
    return { commit, reviewBaseRevision: destination.head };
  }
  async prepare(
    workspace: Workspace,
    target: Workspace,
    reviewId: string,
  ): Promise<PreparedWorkspaceReview> {
    if (
      !workspace.repositoryId ||
      !samePath(await realpath(workspace.repositoryId), await realpath(target.rootPath))
    )
      throw new WorkspaceReviewError('任务工作区与目标项目仓库不匹配。');
    const destination = await this.target(target),
      snapshot = await this.capture(workspace);
    const snapshotCommit = objectId(
      await this.git.run(
        workspace.rootPath,
        [
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          snapshot.tree,
          '-p',
          snapshot.baseRevision,
          '-m',
          'Task snapshot ' + reviewId,
        ],
        { env: identity },
      ),
    );
    let mergeTree: string;
    try {
      mergeTree = objectId(
        (
          await this.git.run(target.rootPath, [
            'merge-tree',
            '--write-tree',
            destination.head,
            snapshotCommit,
          ])
        ).split('\n')[0]!,
      );
    } catch {
      throw new WorkspaceReviewError(
        '当前目标与任务快照无法自动合并；请在任务工作区解决冲突后重新生成审阅（需要 Git 2.38+）。',
      );
    }
    const patch = await this.patch(target.rootPath, destination.head, mergeTree);
    if (!patch) throw new WorkspaceReviewError('任务快照没有可合入目标分支的变更。');
    const mergeCommit = objectId(
      await this.git.run(
        target.rootPath,
        [
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          mergeTree,
          '-p',
          destination.head,
          '-p',
          snapshotCommit,
          '-m',
          'Merge reviewed task ' + reviewId,
        ],
        { env: identity },
      ),
    );
    // Retain immutable review objects across garbage collection; never move a user branch here.
    await this.git.run(target.rootPath, [
      'update-ref',
      'refs/control-plane/reviews/' + reviewId,
      mergeCommit,
    ]);
    return {
      baseRevision: snapshot.baseRevision,
      workspaceHead: snapshot.headRevision,
      snapshotCommit,
      mergeCommit,
      targetHead: destination.head,
      targetBranch: destination.branch,
      patch,
      files: await this.files(target.rootPath, destination.head, mergeTree),
    };
  }
  async isApplied(review: WorkspaceReview, target: Workspace) {
    await this.root(target.rootPath);
    const branch = await this.git.run(target.rootPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    const head = await this.git.run(target.rootPath, ['rev-parse', 'HEAD']);
    return branch === review.targetBranch && head === review.mergeCommit;
  }
  async apply(review: WorkspaceReview, target: Workspace) {
    const current = await this.target(target);
    if (current.head !== review.targetHead || current.branch !== review.targetBranch)
      throw new WorkspaceReviewError('目标分支或提交已变化，请重新生成审阅并批准新快照。');
    await this.temporary(async (hooks) => {
      await this.git.run(target.rootPath, [
        '-c',
        'core.hooksPath=' + hooks,
        '-c',
        'merge.autostash=false',
        'merge',
        '--ff-only',
        '--no-edit',
        '--no-verify',
        review.mergeCommit,
      ]);
    });
    if (!(await this.isApplied(review, target)))
      throw new WorkspaceReviewError('合并结果尚未确认，请核对仓库后重试确认。');
  }
}
