import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { NetworkSettingsService } from './network-settings.js';
import {
  AgentPackageInstallError,
  ownedPackagePath,
  extractAgentTar,
  rejectPackageLinks,
} from './agent-package-io.js';
import { downloadPackageFile, type DownloadProgress } from './agent-package-download.js';

const Record = z.object({
  version: z.string().optional(),
  optional: z.boolean().optional(),
  dev: z.boolean().optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
});
const Lock = z.object({
  lockfileVersion: z.number().min(2),
  packages: z.record(z.string(), Record),
});
function matches(values: string[] | undefined, current: string) {
  if (!values?.length) return true;
  return (
    !values.includes('!' + current) &&
    (values.includes(current) || values.includes('any') || values.every((v) => v.startsWith('!')))
  );
}
function inside(root: string, filename: string) {
  const rel = relative(root, realpathSync(filename));
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** Complete reviewed adapters without leaving native downloads to npm's best-effort optional handling. */
export async function restoreNpmOptionalPackages(options: {
  directory: string;
  npmCli: string;
  network: NetworkSettingsService;
  phase(state: 'downloading' | 'installing', message: string): void;
  progress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}) {
  const root = realpathSync(options.directory);
  const lockFile = join(root, 'package-lock.json');
  if (statSync(lockFile).size > 16 * 1024 * 1024)
    throw new AgentPackageInstallError('安装依赖清单过大。');
  const lock = Lock.parse(JSON.parse(readFileSync(lockFile, 'utf8')));
  const packages = Object.entries(lock.packages).filter(
    ([path, pkg]) =>
      path.startsWith('node_modules/') &&
      pkg.optional &&
      !pkg.dev &&
      !pkg.libc?.length &&
      matches(pkg.os, process.platform) &&
      matches(pkg.cpu, process.arch),
  );
  for (const [index, [path, pkg]] of packages.entries()) {
    options.signal?.throwIfAborted();
    const target = ownedPackagePath(root, path);
    const current = join(target, 'package.json');
    if (
      existsSync(current) &&
      inside(root, current) &&
      JSON.parse(readFileSync(current, 'utf8')).version === pkg.version
    )
      continue;
    const source = pkg.resolved ? new URL(pkg.resolved) : undefined;
    if (
      !source ||
      source.protocol !== 'https:' ||
      source.hostname !== 'registry.npmjs.org' ||
      source.username ||
      source.password ||
      !pkg.version ||
      !pkg.integrity?.startsWith('sha512-')
    )
      throw new AgentPackageInstallError('本机依赖缺少可自动恢复的官方包信息。');
    const work = join(root, '.optional-recovery', randomUUID());
    mkdirSync(work, { recursive: true });
    const archive = join(work, 'package.tgz');
    options.phase('downloading', `正在自动准备运行依赖 ${index + 1}/${packages.length}…`);
    await downloadPackageFile({
      source: source.href,
      destination: archive,
      integrity: pkg.integrity,
      network: options.network,
      progress: options.progress,
      signal: options.signal,
    });
    options.phase('installing', `正在安装运行依赖 ${index + 1}/${packages.length}…`);
    const unpacked = join(work, 'unpacked');
    await extractAgentTar(archive, unpacked, options.npmCli, options.signal);
    rejectPackageLinks(unpacked);
    const program = join(unpacked, 'package');
    const metadata = JSON.parse(readFileSync(join(program, 'package.json'), 'utf8'));
    if (metadata.version !== pkg.version)
      throw new AgentPackageInstallError('运行依赖版本与安装清单不符。');
    options.signal?.throwIfAborted();
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) renameSync(target, target + '.incomplete-' + randomUUID());
    renameSync(program, target);
    if (metadata.bin) {
      const binLinks = createRequire(options.npmCli)('bin-links');
      await binLinks({ path: target, pkg: metadata, top: false, force: false });
    }
  }
}
