import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { ownedPackagePath } from './agent-package-io.js';
import { AgentPackageInstallError } from './agent-package-error.js';

/** All existing ancestors must be ordinary owned directories, including junctions on Windows. */
export function packageFilePath(root: string, name: string) {
  const target = ownedPackagePath(root, name);
  let current = root;
  const parts = relative(root, target).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()))
      throw new AgentPackageInstallError('安装目录包含链接或不支持的路径。');
  }
  return target;
}

export function readPackageJson(filename: string, maxBytes = 128 * 1024): unknown {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new AgentPackageInstallError('安装清单不是普通文件或超过大小限制。');
  return JSON.parse(readFileSync(filename, 'utf8'));
}

const File = z.object({
  path: z.string().min(1).max(4096),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
export const PackageInventory = z
  .array(File)
  .min(1)
  .max(20_000)
  .refine((files) => files.reduce((total, file) => total + file.bytes, 0) <= MAX_PACKAGE_BYTES);
type Inventory = z.infer<typeof PackageInventory>;
async function digest(filename: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest('hex');
}

/** Receipts cover actual files, rather than treating a matching package version as completion. */
export async function packageInventory(root: string, signal?: AbortSignal): Promise<Inventory> {
  const files: Inventory = [];
  let entries = 0,
    totalBytes = 0;
  const visit = async (folder: string, depth: number) => {
    if (depth > 64) throw new AgentPackageInstallError('程序目录层级超过限制。');
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++entries > 20_000) throw new AgentPackageInstallError('程序文件数量超过限制。');
      const filename = packageFilePath(root, relative(root, join(folder, entry.name)));
      if (entry.isDirectory()) await visit(filename, depth + 1);
      else if (entry.isFile()) {
        const bytes = lstatSync(filename).size;
        if ((totalBytes += bytes) > MAX_PACKAGE_BYTES)
          throw new AgentPackageInstallError('程序内容超过大小限制。');
        files.push({
          path: relative(root, filename),
          bytes,
          sha256: await digest(filename, signal),
        });
      } else throw new AgentPackageInstallError('程序目录包含不支持的链接或文件。');
    }
  };
  await visit(root, 0);
  return PackageInventory.parse(files);
}

export async function matchesPackageInventory(
  root: string,
  files: Inventory,
  signal?: AbortSignal,
) {
  try {
    for (const file of files) {
      const filename = packageFilePath(root, file.path),
        info = lstatSync(filename);
      if (
        !info.isFile() ||
        info.size !== file.bytes ||
        (await digest(filename, signal)) !== file.sha256
      )
        return false;
    }
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

export function removePackagePath(root: string, filename: string) {
  const owned = packageFilePath(root, relative(root, filename));
  rmSync(owned, { recursive: true, force: true });
}

export function writePackageJson(root: string, filename: string, value: unknown) {
  packageFilePath(root, relative(root, filename));
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, filename);
  } finally {
    if (existsSync(temporary)) removePackagePath(root, temporary);
  }
}

/** Promote only complete staging trees; restore the previous tree if finalization fails. */
export async function promotePackage(
  root: string,
  staging: string,
  target: string,
  finalize: () => Promise<void>,
) {
  packageFilePath(root, relative(root, staging));
  packageFilePath(root, relative(root, target));
  mkdirSync(dirname(target), { recursive: true });
  const backup = target + '.incomplete-' + randomUUID();
  const previous = existsSync(target);
  if (previous) renameSync(target, backup);
  let promoted = false;
  try {
    renameSync(staging, target);
    promoted = true;
    await finalize();
  } catch (error) {
    if (promoted) removePackagePath(root, target);
    if (previous) renameSync(backup, target);
    throw error;
  }
  if (previous) removePackagePath(root, backup);
}
