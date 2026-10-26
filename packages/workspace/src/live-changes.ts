import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GitObjectIdSchema, type Workspace } from '@control-plane/core';
import { z } from 'zod';
import { NodeGitExecutor } from './git-executor.js';
import type { GitExecutor } from './types.js';
import { WorkspaceReviewError } from './git-review.js';

export const LiveChangesQuerySchema = z
  .object({ path: z.string().min(1).max(1024).optional() })
  .strict();
export const LiveChangesSchema = z.object({
  workspaceId: z.string(),
  baseRevision: GitObjectIdSchema,
  observedAt: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['A', 'M', 'D', 'T', 'unknown']),
      note: z.string().optional(),
    }),
  ),
  detail: z
    .object({
      path: z.string(),
      before: z.string().optional(),
      after: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});
export type LiveChanges = z.infer<typeof LiveChangesSchema>;
export interface WorkspaceLiveChangesReader {
  read(workspace: Workspace, path?: string): Promise<LiveChanges>;
}
type Entry = { mode: string; oid: string; size: number };
const scanFileLimit = 8 * 1024 * 1024;
const textLimit = 1024 * 1024;
const normal = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const text = (bytes: Buffer) => {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};
const blobId = (bytes: Buffer, algorithm: string) =>
  createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Observes raw files and immutable Git blobs. Never stages, creates Git objects or invokes filters. */
export class LocalGitLiveChangesReader implements WorkspaceLiveChangesReader {
  constructor(private readonly git: GitExecutor = new NodeGitExecutor()) {}

  private async file(root: string, path: string): Promise<Buffer | undefined> {
    const parts = path.split('/');
    if (
      /[\\:\x00-\x1f]/.test(path) ||
      parts.some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          p.toLowerCase() === '.git' ||
          p.endsWith('.') ||
          p.endsWith(' '),
      )
    )
      throw new WorkspaceReviewError('此文件路径不能安全读取。');
    let current = root;
    try {
      for (const part of parts) {
        current = join(current, part);
        if (
          (await lstat(current)).isSymbolicLink() ||
          normal(await realpath(current)) !== normal(current)
        )
          throw new WorkspaceReviewError('链接文件或目录不参与实时读取。');
      }
      const before = await lstat(current);
      if (!before.isFile()) throw new WorkspaceReviewError('子模块或特殊文件请在固定快照中审阅。');
      if (before.size > scanFileLimit)
        throw new WorkspaceReviewError('文件超过 8 MiB，未比较内容，请使用固定快照审阅。');
      const handle = await open(current, 'r');
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.ino !== before.ino ||
          info.dev !== before.dev ||
          info.size > scanFileLimit
        )
          throw new WorkspaceReviewError('文件正在变化，下一次更新会重新读取。');
        // Bounded reads also cover files growing while the Agent writes them.
        const bytes = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await handle.stat();
        if (
          length > scanFileLimit ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          normal(await realpath(current)) !== normal(current)
        )
          throw new WorkspaceReviewError('文件正在变化，下一次更新会重新读取。');
        const named = await lstat(current);
        if (named.isSymbolicLink() || named.ino !== info.ino || named.dev !== info.dev)
          throw new WorkspaceReviewError('文件正在变化，下一次更新会重新读取。');
        return bytes.subarray(0, length);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async read(workspace: Workspace, selectedPath?: string): Promise<LiveChanges> {
    if (workspace.provider !== 'git-worktree' || !workspace.baseRevision)
      throw new WorkspaceReviewError('实时改动仅适用于独立 Git 工作区。');
    const base = GitObjectIdSchema.parse(workspace.baseRevision),
      root = workspace.rootPath;
    if (normal(await realpath(root)) !== normal(root))
      throw new WorkspaceReviewError('工作区目录已变化。');
    const run = (args: string[]) =>
      this.git.run(root, ['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args], {
        trim: false,
        timeoutMs: 10_000,
      });
    if (normal((await run(['rev-parse', '--show-toplevel'])).trim()) !== normal(root))
      throw new WorkspaceReviewError('工作区不再指向登记的仓库根目录。');
    const baseline = new Map<string, Entry>();
    for (const row of (await run(['ls-tree', '-r', '-l', '-z', '--full-tree', base]))
      .split('\0')
      .filter(Boolean)) {
      const tab = row.indexOf('\t'),
        [mode, , oid, size] = row.slice(0, tab).trim().split(/\s+/);
      if (tab < 0 || !mode || !oid || size === undefined)
        throw new WorkspaceReviewError('无法读取项目基线。');
      baseline.set(row.slice(tab + 1), { mode, oid, size: Number(size) });
    }
    const paths = [
      ...new Set([
        ...baseline.keys(),
        ...(await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
          .split('\0')
          .filter(Boolean),
      ]),
    ].sort();
    if (paths.length > 5000)
      throw new WorkspaceReviewError('项目超过实时读取的 5000 文件范围，请使用固定快照审阅。');
    if (selectedPath && !paths.includes(selectedPath))
      throw new WorkspaceReviewError('文件已移除或不在当前项目文件中，请刷新列表。');
    const result: LiveChanges = {
      workspaceId: workspace.id,
      baseRevision: base,
      observedAt: new Date().toISOString(),
      files: [],
    };
    let total = 0;
    const deadline = Date.now() + 12_000;
    for (const path of paths) {
      if (Date.now() > deadline)
        throw new WorkspaceReviewError('实时读取耗时过长，请暂停自动更新并使用固定快照审阅。');
      const entry = baseline.get(path);
      try {
        if (entry && !['100644', '100755'].includes(entry.mode))
          throw new WorkspaceReviewError('链接或子模块请在固定快照中审阅。');
        if (total >= 64 * 1024 * 1024)
          throw new WorkspaceReviewError('本次读取达到 64 MiB，其余文件尚未比较。');
        const bytes = await this.file(root, path);
        total += bytes?.length ?? 0;
        const source = bytes && text(bytes);
        const algorithm = base.length === 64 ? 'sha256' : 'sha1';
        // A Windows checkout may use CRLF while its Git blob uses LF.
        const equal =
          bytes &&
          entry &&
          (blobId(bytes, algorithm) === entry.oid ||
            (source !== undefined &&
              blobId(Buffer.from(source.replaceAll('\r\n', '\n')), algorithm) === entry.oid));
        if (!equal && (entry || bytes))
          result.files.push({ path, status: !bytes ? 'D' : !entry ? 'A' : 'M' });
        if (path === selectedPath) {
          if (
            (entry && entry.size > textLimit) ||
            (bytes && bytes.length > textLimit) ||
            (bytes && source === undefined)
          ) {
            result.detail = {
              path,
              note: '二进制、非 UTF-8 或超过 1 MiB 的文件不展开内容，请查看固定快照。',
            };
          } else {
            const before = entry
              ? await run(['cat-file', 'blob', GitObjectIdSchema.parse(entry.oid)])
              : '';
            result.detail =
              before.includes('\0') || before.includes('\uFFFD')
                ? { path, note: '基线不是可显示的 UTF-8 文本，请查看固定快照。' }
                : { path, before, after: source ?? '' };
          }
        }
      } catch (error) {
        const note =
          error instanceof WorkspaceReviewError
            ? error.message
            : '文件暂时无法读取，下一次更新将重试。';
        result.files = result.files.filter((file) => file.path !== path);
        result.files.push({ path, status: 'unknown', note });
        if (path === selectedPath) result.detail = { path, note };
      }
    }
    if (normal(await realpath(root)) !== normal(root))
      throw new WorkspaceReviewError('工作区目录已变化。');
    return LiveChangesSchema.parse(result);
  }
}
