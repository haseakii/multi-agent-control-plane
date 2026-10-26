import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import type { NetworkSettingsService } from './network-settings.js';
import { extractAgentTar, rejectPackageLinks } from './agent-package-io.js';
import { AgentPackageInstallError } from './agent-package-error.js';
import { downloadPackageFile, type DownloadProgress } from './agent-package-download.js';
import { npmOptionalPackages } from './agent-npm-lock.js';
import {
  PackageInventory,
  matchesPackageInventory,
  packageFilePath,
  packageInventory,
  promotePackage,
  readPackageJson,
  removePackagePath,
  writePackageJson,
} from './agent-package-files.js';
import { packageChecksums } from './agent-package-integrity.js';

const Receipt = z.object({ version: z.string(), integrity: z.string(), files: PackageInventory });
const Manifest = z
  .object({
    version: z.string(),
    bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  })
  .passthrough();

/** Recover any fixed npm ACP package using lock metadata; product identity does not select this path. */
export async function restoreNpmOptionalPackages(options: {
  directory: string;
  npmCli: string;
  network: Pick<NetworkSettingsService, 'fetch'>;
  phase(state: 'downloading' | 'installing', message: string): void;
  progress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}) {
  const root = realpathSync(options.directory);
  const packages = npmOptionalPackages(root);
  for (const [index, [path, pkg]] of packages.entries()) {
    options.signal?.throwIfAborted();
    const target = packageFilePath(root, path);
    let source: URL;
    try {
      source = new URL(pkg.resolved!);
    } catch {
      throw new AgentPackageInstallError('本机依赖缺少可自动恢复的官方包信息。');
    }
    if (
      source.protocol !== 'https:' ||
      source.hostname !== 'registry.npmjs.org' ||
      source.port ||
      source.username ||
      source.password ||
      !pkg.version ||
      !pkg.integrity
    )
      throw new AgentPackageInstallError('本机依赖缺少可自动恢复的官方包信息。');
    packageChecksums({ integrity: pkg.integrity });
    const key = createHash('sha256')
      .update(path + '\0' + pkg.integrity)
      .digest('hex');
    const work = packageFilePath(root, '.optional-recovery/' + key);
    mkdirSync(work, { recursive: true });
    const receiptFile = packageFilePath(root, '.optional-recovery/' + key + '/receipt.json');
    if (existsSync(target) && existsSync(receiptFile)) {
      try {
        const receipt = Receipt.parse(readPackageJson(receiptFile, 8 * 1024 * 1024));
        if (
          receipt.version === pkg.version &&
          receipt.integrity === pkg.integrity &&
          (await matchesPackageInventory(target, receipt.files, options.signal))
        )
          continue;
      } catch {
        options.signal?.throwIfAborted(); /* Damaged receipts are repaired from the verified archive. */
      }
    }
    const archive = packageFilePath(root, '.optional-recovery/' + key + '/package.tgz');
    options.phase('downloading', `正在自动准备运行依赖 ${index + 1}/${packages.length}…`);
    await downloadPackageFile({
      source: source.href,
      destination: archive,
      integrity: pkg.integrity,
      resumeExisting: true,
      network: options.network,
      progress: options.progress,
      signal: options.signal,
    });
    options.phase('installing', `正在安装运行依赖 ${index + 1}/${packages.length}…`);
    const unpacked = packageFilePath(
      root,
      '.optional-recovery/' + key + '/unpacked-' + randomUUID(),
    );
    try {
      await extractAgentTar(archive, unpacked, options.npmCli, options.signal);
      rejectPackageLinks(unpacked);
      const program = packageFilePath(unpacked, 'package');
      const metadata = Manifest.parse(readPackageJson(packageFilePath(program, 'package.json')));
      const bins =
        typeof metadata.bin === 'string' ? [metadata.bin] : Object.values(metadata.bin ?? {});
      for (const bin of bins) packageFilePath(program, bin);
      if (metadata.version !== pkg.version)
        throw new AgentPackageInstallError('运行依赖版本与安装清单不符。');
      options.signal?.throwIfAborted();
      await promotePackage(root, program, target, async () => {
        if (metadata.bin) {
          const binRoot = path.slice(0, path.lastIndexOf('node_modules/')) + 'node_modules/.bin';
          packageFilePath(root, binRoot);
          const binLinks = createRequire(options.npmCli)('bin-links');
          await binLinks({ path: target, pkg: metadata, top: false, force: false });
        }
        const files = await packageInventory(target, options.signal);
        options.signal?.throwIfAborted();
        writePackageJson(root, receiptFile, {
          version: pkg.version!,
          integrity: pkg.integrity!,
          files,
        });
      });
    } finally {
      if (existsSync(unpacked)) removePackagePath(root, unpacked);
    }
  }
}
