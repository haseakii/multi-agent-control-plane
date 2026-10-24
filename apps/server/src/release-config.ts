import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  lockFileIdentity,
  windowsInstanceLockRemover,
  type LockFileIdentity,
  type InstanceLockRemover,
} from './instance-lock-remover.js';

export const maintenanceMarker = 'NOT-A-RUN-DIRECTORY';

export const ReleaseConfigSchema = z
  .object({
    version: z.literal(1),
    port: z.number().int().min(1).max(65535).default(3000),
    dataDir: z.string().trim().min(1).default('./data'),
    clientAccessFile: z.string().trim().min(1).optional(),
    startupAgents: z
      .array(z.object({ agentId: z.string().min(1), authMethodId: z.string().min(1) }).strict())
      .max(32)
      .default([]),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  })
  .strict();
function assertMaintenanceComplete(dataDir: string, configFile?: string): void {
  const directories = [dataDir, ...(configFile ? [dirname(resolve(configFile))] : [])];
  if (directories.some((directory) => existsSync(join(directory, maintenanceMarker))))
    throw new Error('Backup or incomplete maintenance directory is not runnable.');
}
export function readReleaseConfig(filename: string) {
  const path = resolve(filename);
  const config = ReleaseConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const dataDir = resolve(dirname(path), config.dataDir);
  assertMaintenanceComplete(dataDir, path);
  return {
    ...config,
    ...(config.clientAccessFile
      ? { clientAccessFile: resolve(dirname(path), config.clientAccessFile) }
      : {}),
    dataDir,
    host: '127.0.0.1' as const,
  };
}
/** Recover only a verified exited owner through the identity-checked native handle. */
export function acquireInstanceLock(
  dataDir: string,
  configFile?: string,
  remover: InstanceLockRemover = windowsInstanceLockRemover,
): () => void {
  mkdirSync(dataDir, { recursive: true });
  const filename = join(realpathSync(dataDir), 'instance.lock');
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(filename, 'wx');
  } catch (error) {
    let recovered = false;
    if (existsSync(filename) && remover.recover) {
      let existing: number | undefined;
      try {
        existing = openSync(filename, 'r');
        const identity = lockFileIdentity(existing);
        const owner = z
          .object({
            pid: z.number().int().positive().max(0xffffffff),
            token: z.uuid(),
            startedAt: z.iso.datetime(),
          })
          .strict()
          .parse(JSON.parse(readFileSync(existing, 'utf8')));
        recovered = remover.recover(filename, identity, owner.token, owner.pid).removed;
      } catch {
        /* Missing or inaccessible owner information stays fail closed. */
      } finally {
        if (existing !== undefined) closeSync(existing);
      }
    }
    if (recovered) {
      console.info('INSTANCE_LOCK_RECOVERED: 已确认原进程退出，正在恢复同一数据目录。');
      fd = openSync(filename, 'wx');
    } else if (existsSync(filename))
      throw Object.assign(
        new Error(
          `Data directory is locked: ${filename}. Close the existing foreground instance first. After a crash follow RUN.txt; stale locks are not removed automatically.`,
        ),
        { code: 'INSTANCE_LOCKED' },
      );
    else throw error;
  }
  let initialized = false;
  let identity: LockFileIdentity | undefined;
  const removeOwnedFile = () => {
    try {
      if (identity) {
        const result = remover.remove(filename, identity, initialized ? token : undefined);
        if (result.removed || result.reason === 'not_found') return;
      }
    } catch {
      // Uncertain identity or unavailable native operation must not trigger path deletion.
    }
    console.warn(
      'INSTANCE_LOCK_RETAINED: 无法通过已验证的文件句柄安全移除实例锁，已保留原路径。' +
        '请保留目录和锁；确认原实例已退出后按 RUN.txt 恢复到新私有目录，不自动抢锁或删除替换文件。',
    );
  };
  try {
    identity = lockFileIdentity(fd);
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
    );
    initialized = true;
  } finally {
    closeSync(fd);
    if (!initialized) removeOwnedFile();
  }
  const release = () => removeOwnedFile();
  try {
    // Recheck under the data lock before callers may open the database.
    assertMaintenanceComplete(dataDir, configFile);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
