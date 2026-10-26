import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AgentPackageInstallError } from './agent-package-error.js';
import {
  matchesPackageInventory,
  packageFilePath,
  packageInventory,
  promotePackage,
  removePackagePath,
} from './agent-package-files.js';

/** A complete, reusable short-path mirror; filesystems without hard links use ordinary copies. */
export async function prepareNativeRuntime(
  root: string,
  source: string,
  name: string,
  signal?: AbortSignal,
) {
  packageFilePath(root, relative(root, source));
  const target = packageFilePath(root, name);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !path || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
  };
  if (contains(source, target) || contains(target, source))
    throw new AgentPackageInstallError('原生运行目录与源程序重叠。');
  const inventory = await packageInventory(source, signal);
  if (existsSync(target) && (await matchesPackageInventory(target, inventory, signal)))
    return target;
  const staging = packageFilePath(root, name + '.preparing-' + randomUUID());
  const mirror = (from: string, to: string) => {
    signal?.throwIfAborted();
    mkdirSync(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const original = packageFilePath(source, relative(source, join(from, entry.name))),
        destination = join(to, entry.name);
      if (entry.isDirectory()) mirror(original, destination);
      else if (entry.isFile()) {
        try {
          linkSync(original, destination);
        } catch (error) {
          if (
            !['EXDEV', 'ENOTSUP', 'EPERM', 'EACCES'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
          copyFileSync(original, destination, constants.COPYFILE_EXCL);
        }
      } else throw new AgentPackageInstallError('原生运行目录包含不支持的链接或文件。');
    }
  };
  try {
    mirror(source, staging);
    await promotePackage(root, staging, target, async () => {
      signal?.throwIfAborted();
    });
    return target;
  } finally {
    if (existsSync(staging)) removePackagePath(root, staging);
  }
}
