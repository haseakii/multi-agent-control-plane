import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { AgentPackageInstallError } from './agent-package-error.js';
import { npmHost, npmOptionalPackages } from './agent-npm-lock.js';
import { packageFilePath, readPackageJson } from './agent-package-files.js';

/** Recovery and final verification use exactly the same host package selection. */
export function verifyNpmPlatformPackages(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libc = npmHost().libc,
) {
  try {
    const root = realpathSync(directory);
    for (const [path, pkg] of npmOptionalPackages(root, { os: platform, arch, libc })) {
      const installed = z
        .object({ version: z.string() })
        .parse(readPackageJson(packageFilePath(root, path + '/package.json')));
      if (!pkg.version || installed.version !== pkg.version)
        throw new Error('Dependency version mismatch.');
    }
  } catch {
    throw new AgentPackageInstallError('npm 本机平台依赖安装不完整，请检查安装依赖清单。');
  }
}
