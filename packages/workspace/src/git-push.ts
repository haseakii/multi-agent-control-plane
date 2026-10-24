import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GitObjectIdSchema,
  GitRemoteNameSchema,
  type Workspace,
  type WorkspacePush,
} from '@control-plane/core';
import { NodeGitExecutor } from './git-executor.js';
import { WorkspaceReviewError } from './git-review.js';
import type { GitExecutor } from './types.js';

export type PushDestination = { destination: string; destinationHash: string };
export interface WorkspacePushAdapter {
  remotes(source: Workspace): Promise<string[]>;
  destination(
    source: Workspace,
    remote: string,
    branch: string,
    commit: string,
  ): Promise<PushDestination>;
  push(source: Workspace, push: WorkspacePush, destination: PushDestination): Promise<void>;
  isPushed(source: Workspace, push: WorkspacePush, destination: PushDestination): Promise<boolean>;
}
const options = { env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, timeoutMs: 60000 };
/** Only an explicit immutable commit and one verified destination are sent; no force/tags/submodule pushes. */
export class LocalGitPushAdapter implements WorkspacePushAdapter {
  constructor(private readonly git: GitExecutor = new NodeGitExecutor()) {}
  private async root(source: Workspace) {
    const actual = await realpath(source.rootPath);
    const top = await this.git.run(actual, ['rev-parse', '--show-toplevel']);
    const normalize = (value: string) =>
      process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
    if (normalize(actual) !== normalize(source.rootPath) || normalize(top) !== normalize(actual))
      throw new WorkspaceReviewError('项目目录必须仍指向已登记的 Git 仓库根目录。');
  }
  async remotes(source: Workspace) {
    await this.root(source);
    return (await this.git.run(source.rootPath, ['remote']))
      .split('\n')
      .filter((name) => GitRemoteNameSchema.safeParse(name).success);
  }
  async destination(source: Workspace, raw: string, branch: string, commit: string) {
    const remote = GitRemoteNameSchema.parse(raw);
    GitObjectIdSchema.parse(commit);
    await this.root(source);
    await this.git.run(source.rootPath, ['check-ref-format', 'refs/heads/' + branch]);
    await this.git
      .run(source.rootPath, ['merge-base', '--is-ancestor', commit, 'refs/heads/' + branch])
      .catch(() => {
        throw new WorkspaceReviewError('已审阅提交已不在目标本地分支中，请重新审阅。');
      });
    const urls = (
      await this.git.run(source.rootPath, ['remote', 'get-url', '--push', '--all', remote])
    )
      .split('\n')
      .filter(Boolean);
    if (urls.length !== 1) throw new WorkspaceReviewError('请选择只有一个推送地址的远端。');
    const destination = urls[0]!;
    if (
      /\s|[\x00-\x1f]/.test(destination) ||
      destination.startsWith('-') ||
      destination.includes('::')
    )
      throw new WorkspaceReviewError('此远端地址格式不受支持，请使用标准 HTTPS、SSH 或本地路径。');
    if (destination.includes('://')) {
      const url = new URL(destination);
      if (
        !['https:', 'ssh:', 'file:'].includes(url.protocol) ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === 'https:' && url.username)
      )
        throw new WorkspaceReviewError('推送地址不能包含凭据或查询参数，请通过 Git 自身完成认证。');
    }
    return { destination, destinationHash: createHash('sha256').update(destination).digest('hex') };
  }
  async push(source: Workspace, push: WorkspacePush, target: PushDestination) {
    await this.git.run(
      source.rootPath,
      [
        '-c',
        'push.followTags=false',
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--recurse-submodules=no',
        '--',
        target.destination,
        push.commit + ':refs/heads/' + push.targetBranch,
      ],
      options,
    );
  }
  async isPushed(source: Workspace, push: WorkspacePush, target: PushDestination) {
    const output = await this.git.run(
      source.rootPath,
      ['ls-remote', '--refs', '--', target.destination, 'refs/heads/' + push.targetBranch],
      options,
    );
    return output
      .split('\n')
      .some((line) => line === push.commit + '\trefs/heads/' + push.targetBranch);
  }
}
