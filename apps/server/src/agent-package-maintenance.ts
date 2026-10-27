import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AgentDefinition, AgentInstallation } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import type { AgentControlService } from './agent-control.js';
import { TaskControlError } from './task-control.js';

export const PackageMaintenanceAction = z.enum(['history', 'uninstall']);
export const PackageMaintenanceRequest = z.object({ action: PackageMaintenanceAction }).strict();
export const ConfirmPackageMaintenance = PackageMaintenanceRequest.extend({
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const PackageMaintenancePreview = z
  .object({
    installationId: z.string().uuid(),
    action: PackageMaintenanceAction,
    planHash: z.string(),
    paths: z.array(z.string()),
    bytes: z.number().nonnegative(),
    files: z.number().int().nonnegative(),
    members: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
    blockers: z.array(z.string()),
    canApply: z.boolean(),
  })
  .strict();

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Match direct entries, interpreter scripts, cwd and configured paths, including aliases. */
export function runtimeUsesDirectory(runtime: AgentDefinition['runtime'], directory: string) {
  const values = [runtime.command, ...runtime.args, runtime.cwd];
  return values.some((value) => {
    if (!value || !isAbsolute(value)) return false;
    if (inside(directory, value)) return true;
    try {
      return inside(realpathSync(directory), realpathSync(value));
    } catch {
      return false;
    }
  });
}

/** Only the journalled installation/request subtree is owned. Never accept client paths. */
function requestDirectory(root: string, row: AgentInstallation) {
  if (!row.directory)
    throw new TaskControlError(409, '此旧记录没有可验证的安装目录，不能自动删除。');
  const path = resolve(row.directory),
    rel = relative(resolve(root), path),
    parts = rel.split(sep);
  if (
    parts.length !== 4 ||
    parts[0] !== row.entryId ||
    parts[1] !== row.version ||
    parts[2] !== row.id ||
    !z.string().uuid().safeParse(parts[3]).success ||
    !inside(root, path)
  )
    throw new TaskControlError(409, '安装目录不属于此记录，已拒绝删除。');
  return dirname(path);
}

function assertNoLinkAncestors(path: string) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new TaskControlError(409, '清理路径包含符号链接或目录联接，不能自动删除。');
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
}

/** Bounded snapshot; links may only point inside the deletion set and are never traversed. */
function inventory(paths: string[]) {
  const entries: unknown[] = [];
  let bytes = 0,
    files = 0;
  const pending = [...paths];
  while (pending.length) {
    const path = pending.pop()!;
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (absent(error)) continue;
      throw error;
    }
    if (
      entries.length >= 100_000 ||
      (!stat.isSymbolicLink() && !stat.isFile() && !stat.isDirectory())
    )
      throw new TaskControlError(409, '目录包含链接、特殊文件或过多文件，不能自动清理。');
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(path);
      } catch {
        throw new TaskControlError(409, '目录包含失效链接，不能自动清理。');
      }
      if (!paths.some((root) => inside(root, target)))
        throw new TaskControlError(409, '目录包含指向外部的链接，不能自动清理。');
      entries.push([path, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, readlinkSync(path)]);
      files++;
      continue; // rm unlinks an internal package link; never walk its target.
    }
    entries.push([path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (stat.isDirectory()) {
      const names = readdirSync(path).sort();
      if (names.length + pending.length + entries.length > 100_000)
        throw new TaskControlError(409, '目录文件过多，不能自动清理。');
      for (const name of names) pending.push(join(path, name));
    } else {
      bytes += stat.size;
      files++;
    }
  }
  return { entries, bytes, files };
}

export class AgentPackageMaintenance {
  constructor(
    private readonly options: {
      storage: SqliteStorage;
      agents: AgentControlService;
      root: string;
      busy: () => boolean;
    },
  ) {}

  preview(id: string, raw: unknown) {
    const { action } = PackageMaintenanceRequest.parse(raw);
    const row = this.options.storage.repositories.agentInstallations.get(
      z.string().uuid().parse(id),
    );
    if (!row) throw new TaskControlError(404, '安装记录不存在。');
    const directory = requestDirectory(this.options.root, row);
    assertNoLinkAncestors(directory);
    const blockers: string[] = [];
    if (this.options.busy()) blockers.push('正在安装或创建成员，请等待当前操作完成。');
    if (row.package?.origin === 'registered-entry' && action === 'uninstall')
      blockers.push('此记录复用外部程序，请使用原安装方式卸载。');
    let children: string[] = [];
    try {
      children = readdirSync(directory)
        .filter((name) => z.string().uuid().safeParse(name).success)
        .sort()
        .map((name) => join(directory, name));
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const definitions = this.options.storage.repositories.agentDefinitions.list();
    const rows = this.options.storage.repositories.agentInstallations.list();
    const origins = this.options.storage.repositories.agentMemberOrigins.list();
    const related = new Set<string>(row.agentId ? [row.agentId] : []);
    for (const origin of origins) if (origin.installationId === id) related.add(origin.id);
    for (let changed = true; changed; ) {
      changed = false;
      for (const origin of origins)
        if (origin.sourceAgentId && related.has(origin.sourceAgentId) && !related.has(origin.id)) {
          related.add(origin.id);
          changed = true;
        }
    }
    const current = row.package ? resolve(row.directory!) : undefined;
    const paths: string[] = [];
    for (const child of children) {
      const used =
        definitions.some((agent) => runtimeUsesDirectory(agent.runtime, child)) ||
        rows.some(
          (other) =>
            other.id !== id &&
            other.package &&
            (runtimeUsesDirectory(other.package.runtime, child) ||
              (other.directory && inside(child, other.directory))),
        );
      if (action === 'uninstall') paths.push(child);
      else if (child !== current && !used) paths.push(child);
    }
    // Only known disposable download outputs; no shared Python/Node runtimes or login homes.
    if (action === 'history' && current) {
      for (const name of ['cache', 'package.zip', 'package.tar', 'package.raw']) {
        const path = join(current, name);
        if (
          !definitions.some((agent) => runtimeUsesDirectory(agent.runtime, path)) &&
          !rows.some((other) => other.package && runtimeUsesDirectory(other.package.runtime, path))
        ) {
          try {
            lstatSync(path);
            paths.push(path);
          } catch (error) {
            if (!absent(error)) throw error;
          }
        }
      }
    }
    for (const path of paths) {
      if (!inside(directory, path) || resolve(path) === directory)
        throw new Error('Unsafe cleanup target.');
      assertNoLinkAncestors(path);
    }
    const affected = definitions.filter(
      (agent) =>
        related.has(agent.id) || paths.some((path) => runtimeUsesDirectory(agent.runtime, path)),
    );
    // Even an empty/missing current directory must retain its member configuration and idle checks.
    for (const agent of definitions)
      if (runtimeUsesDirectory(agent.runtime, row.directory!) && !affected.includes(agent))
        affected.push(agent);
    for (const agent of affected)
      blockers.push(
        ...this.options.agents
          .programRemovalBlockers(agent.id)
          .filter((reason) => action === 'uninstall' || reason !== '请先停用成员')
          .map((reason) => `${agent.name}：${reason}`),
      );
    if (action === 'uninstall') {
      if (
        rows.some(
          (other) =>
            other.id !== id &&
            other.package &&
            paths.some((path) => runtimeUsesDirectory(other.package!.runtime, path)),
        )
      )
        blockers.push('其他安装记录仍复用此程序，不能卸载。');
    }
    const snapshot = inventory(paths);
    const planHash = digest({ action, row, paths, entries: snapshot.entries, affected, blockers });
    return PackageMaintenancePreview.parse({
      installationId: id,
      action,
      planHash,
      paths,
      bytes: snapshot.bytes,
      files: snapshot.files,
      members: affected.map((agent) => ({
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
      })),
      blockers,
      canApply:
        blockers.length === 0 &&
        (paths.length > 0 || (action === 'uninstall' && row.state !== 'uninstalled')),
    });
  }

  apply(id: string, raw: unknown) {
    const input = ConfirmPackageMaintenance.parse(raw);
    const plan = this.preview(id, { action: input.action });
    if (plan.planHash !== input.planHash)
      throw new TaskControlError(409, '文件或成员状态已变化，请重新预览。');
    if (!plan.canApply)
      throw new TaskControlError(409, plan.blockers.join(' ') || '没有可清理的内容。');
    const repo = this.options.storage.repositories.agentInstallations;
    let row = repo.get(id)!;
    if (input.action === 'uninstall') {
      // Journal before touching files. Interrupted/partial removals cannot be reused as installed packages.
      const { package: _package, ...rest } = row;
      row = repo.upsert({
        ...rest,
        state: 'removing',
        message: '正在卸载程序，成员配置和历史保留。',
        updatedAt: new Date().toISOString(),
      });
    }
    try {
      // Synchronous bounded mutation: no other request can enable/probe/retry between revalidation and removal.
      for (const path of plan.paths) {
        assertNoLinkAncestors(path);
        rmSync(path, { recursive: true, force: true });
      }
      if (input.action === 'uninstall')
        repo.upsert({
          ...row,
          state: 'uninstalled',
          message:
            '程序已卸载，下载文件已清理；成员配置、登录数据和历史保留。重新使用请重新安装并配置入口。',
          updatedAt: new Date().toISOString(),
        });
    } catch {
      if (input.action === 'uninstall')
        repo.upsert({
          ...row,
          state: 'removal-failed',
          message:
            '卸载未完成，可能有文件被占用。请关闭相关程序后重新预览并重试；部分文件可能已删除。',
          updatedAt: new Date().toISOString(),
        });
      throw new TaskControlError(
        409,
        '清理未全部完成。部分文件可能已删除，请关闭相关程序后重新预览。',
      );
    }
    return {
      installationId: id,
      action: input.action,
      removedPaths: plan.paths,
      bytes: plan.bytes,
      message:
        input.action === 'uninstall'
          ? '程序已卸载，成员配置与历史保留。'
          : '历史下载已清理，当前程序保留。',
    };
  }
}
