import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { AgentPackageInstallError, ownedPackagePath } from './agent-package-io.js';

const Lock = z.object({
  lockfileVersion: z.number().min(2),
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      optional: z.boolean().optional(),
      dev: z.boolean().optional(),
      os: z.array(z.string()).optional(),
      cpu: z.array(z.string()).optional(),
      libc: z.array(z.string()).optional(),
    }),
  ),
});

function matches(values: string[] | undefined, current: string): boolean {
  if (!values?.length) return true;
  if (values.includes('!' + current)) return false;
  const allowed = values.filter((value) => !value.startsWith('!'));
  return !allowed.length || allowed.includes('any') || allowed.includes(current);
}

/** npm can omit failed optional packages; verify local platform packages before registration. */
export function verifyNpmPlatformPackages(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  try {
    const root = realpathSync(directory);
    const file = join(root, 'package-lock.json');
    if (statSync(file).size > 16 * 1024 * 1024) throw new Error('Oversized lockfile.');
    const lock = Lock.parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (
        !path.startsWith('node_modules/') ||
        !pkg.optional ||
        pkg.dev ||
        !(pkg.os?.length || pkg.cpu?.length) ||
        !matches(pkg.os, platform) ||
        !matches(pkg.cpu, arch) ||
        // libc variants need npm's libc selection, rather than an OS/CPU-only check.
        pkg.libc?.length
      )
        continue;
      const manifest = realpathSync(join(ownedPackagePath(root, path), 'package.json'));
      const rel = relative(root, manifest);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new Error('Platform package is outside the installation.');
      const installed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
      if (!pkg.version || installed.version !== pkg.version)
        throw new Error('Platform package version mismatch.');
    }
  } catch {
    throw new AgentPackageInstallError('npm 本机平台依赖安装不完整，请重试安装。');
  }
}
