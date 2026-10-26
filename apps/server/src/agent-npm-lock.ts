import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { packageFilePath, readPackageJson } from './agent-package-files.js';
import { AgentPackageInstallError } from './agent-package-error.js';

const Package = z.object({
  version: z.string().max(256).optional(),
  optional: z.boolean().optional(),
  dev: z.boolean().optional(),
  link: z.boolean().optional(),
  os: z.array(z.string().max(64)).max(32).optional(),
  cpu: z.array(z.string().max(64)).max(32).optional(),
  libc: z.array(z.string().max(64)).max(32).optional(),
  resolved: z.string().max(8192).optional(),
  integrity: z.string().max(4096).optional(),
});
const Lock = z.object({
  lockfileVersion: z.number().int().min(2),
  packages: z.record(z.string(), Package),
});
export type NpmHost = { os: NodeJS.Platform; arch: string; libc?: string | undefined };
export function npmHost(): NpmHost {
  let libc: string | undefined;
  if (process.platform === 'linux') {
    const report = process.report?.getReport();
    if (report && typeof report !== 'string')
      libc = (report as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime
        ? 'glibc'
        : 'musl';
  }
  return { os: process.platform, arch: process.arch, libc };
}
export function matchesNpmPlatform(values: string[] | undefined, current: string | undefined) {
  if (!values?.length) return true;
  if (!current) return false;
  const allowed = values.filter((value) => !value.startsWith('!'));
  return (
    !values.includes('!' + current) &&
    (!allowed.length || allowed.includes('any') || allowed.includes(current))
  );
}

/** One parser and host selector shared by recovery and the final installation check. */
export function npmOptionalPackages(directory: string, host = npmHost()) {
  const root = realpathSync(directory);
  const lock = Lock.parse(
    readPackageJson(packageFilePath(root, 'package-lock.json'), 16 * 1024 * 1024),
  );
  const name = '(?:@[a-zA-Z0-9_~][a-zA-Z0-9._~-]*/)?[a-zA-Z0-9_~][a-zA-Z0-9._~-]*';
  const pathPattern = new RegExp(`^node_modules/${name}(?:/node_modules/${name})*$`);
  return Object.entries(lock.packages)
    .filter(([path, pkg]) => {
      if (!path) return false;
      if (!pathPattern.test(path))
        throw new AgentPackageInstallError('安装依赖清单包含不支持的包路径。');
      packageFilePath(root, path);
      if (
        !pkg.optional ||
        pkg.dev ||
        !matchesNpmPlatform(pkg.os, host.os) ||
        !matchesNpmPlatform(pkg.cpu, host.arch)
      )
        return false;
      if (pkg.link) throw new AgentPackageInstallError('运行依赖不能引用安装目录外的链接。');
      if (pkg.libc?.length && host.os === 'linux' && !host.libc)
        throw new AgentPackageInstallError('无法确定本机 libc，未安装不匹配的运行依赖。');
      return matchesNpmPlatform(pkg.libc, host.libc);
    })
    .sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}
