import { createHash } from 'node:crypto';
import { InstallProcessError, runInstallProcess } from './agent-install-process.js';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installedPackageEntries } from './agent-installed-package.js';
import { verifyNpmPlatformPackages } from './agent-npm-integrity.js';
import { restoreNpmOptionalPackages } from './agent-npm-recovery.js';
import { adapterRuntimeEnvironment } from './agent-install-adapters.js';
import type { CatalogEntry } from './agent-catalog.js';
import { applyNetworkEnvironment, type NetworkSettingsService } from './network-settings.js';
import { TaskControlError } from './task-control.js';
import { catalogEnvironment, managedAgentRuntime } from './agent-launcher.js';
import {
  installPythonAgent,
  MANAGED_PYTHON_REQUEST,
  MANAGED_UV_VERSION,
} from './agent-python-runtime.js';
import {
  AgentPackageInstallError,
  ownedPackagePath,
  downloadPackageFile,
  extractAgentZip,
  extractAgentTar,
  rejectPackageLinks,
  type DownloadProgress,
} from './agent-package-io.js';
export { AgentPackageInstallError } from './agent-package-io.js';

const ExactPackage =
  /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/;
const ExactPythonPackage =
  /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:==|@)(\d+\.\d+\.\d+(?:(?:a|b|rc|\.post|\.dev)\d+)?)$/;
function environmentFor(value?: Record<string, string>) {
  try {
    const environment = catalogEnvironment(value);
    return Object.keys(environment).length ? { environment } : {};
  } catch {
    throw new TaskControlError(409, '此产品的目录环境设置不能自动应用，请使用已有本机入口。');
  }
}
export function packagePlan(entry: CatalogEntry, platform: string, npmAvailable: boolean) {
  const binary =
    entry.distribution.binary?.[
      platform as keyof NonNullable<CatalogEntry['distribution']['binary']>
    ];
  const pathname = binary ? new URL(binary.archive).pathname.toLowerCase() : '';
  const format = pathname.endsWith('.zip')
    ? ('zip' as const)
    : /\.(?:tar\.gz|tgz)$/.test(pathname) && npmAvailable
      ? ('tar' as const)
      : pathname.endsWith('.exe')
        ? ('raw' as const)
        : undefined;
  let distribution;
  if (
    binary &&
    platform.startsWith('windows-') &&
    format &&
    /\.(?:exe|cmd|bat)$/i.test(binary.cmd)
  ) {
    if (new URL(binary.archive).protocol !== 'https:')
      throw new TaskControlError(409, '此产品下载地址不支持安全安装。');
    // Validate before downloading, including archives with nested program paths.
    ownedPackagePath('C:/package-plan', binary.cmd.replaceAll('\\', '/'));
    distribution = {
      kind: format,
      source: binary.archive,
      cmd: binary.cmd,
      args: binary.args ?? [],
      sha256: binary.sha256?.toLowerCase(),
      ...environmentFor(binary.env),
    };
  } else if (
    entry.distribution.npx &&
    npmAvailable &&
    ExactPackage.test(entry.distribution.npx.package)
  ) {
    distribution = {
      kind: 'npm' as const,
      source: entry.distribution.npx.package,
      args: entry.distribution.npx.args ?? [],
      ...environmentFor(entry.distribution.npx.env),
    };
  } else if (
    entry.distribution.uvx &&
    platform.startsWith('windows-') &&
    ExactPythonPackage.test(entry.distribution.uvx.package)
  ) {
    const spec = ExactPythonPackage.exec(entry.distribution.uvx.package)!;
    distribution = {
      kind: 'uv' as const,
      source: `${spec[1]}==${spec[2]}`,
      packageName: spec[1]!,
      args: entry.distribution.uvx.args ?? [],
      python: MANAGED_PYTHON_REQUEST,
      uv: MANAGED_UV_VERSION,
      ...environmentFor(entry.distribution.uvx.env),
    };
  } else
    throw new TaskControlError(
      409,
      '此产品当前没有可自动安装的本平台程序或固定版本包。可使用本机已有 ACP 入口。',
    );
  const plan = { entryId: entry.id, name: entry.name, version: entry.version, distribution };
  return {
    ...plan,
    planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    integrity:
      distribution.kind === 'npm'
        ? 'npm-integrity'
        : distribution.kind === 'uv'
          ? 'pypi-integrity'
          : distribution.sha256
            ? 'sha256'
            : 'https-source',
    source: distribution.source,
    runtime:
      distribution.kind === 'uv'
        ? 'Python（自动准备）'
        : distribution.kind === 'npm'
          ? 'Node.js（工作台自带）'
          : '本机程序（自动配置入口）',
  };
}

export function npmRuntime(root: string) {
  const candidates = [
    join(root, 'runtime/npm/bin/npm-cli.js'),
    join(process.execPath, '../node_modules/npm/bin/npm-cli.js'),
  ];
  return candidates.find(existsSync);
}

export async function installAgentPackage(options: {
  plan: ReturnType<typeof packagePlan>;
  directory: string;
  releaseRoot: string;
  network: NetworkSettingsService;
  runtimeRoot?: string;
  nodeExecutable?: string;
  run?: (
    command: string,
    args: string[],
    options: import('node:child_process').ExecFileOptions,
  ) => Promise<unknown>;
  phase: (state: 'downloading' | 'installing', message: string) => void;
  progress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}) {
  const { plan, directory, network } = options;
  options.signal?.throwIfAborted();
  mkdirSync(directory, { recursive: true });
  const distribution = plan.distribution;
  const adapt = (
    command: string,
    prefixArgs: string[] = [],
    runtimeEnvironment: Record<string, string> = {},
  ) =>
    managedAgentRuntime({
      directory,
      command,
      prefixArgs,
      args: distribution.args,
      environment: distribution.environment,
      runtimeEnvironment,
      nodeExecutable: options.nodeExecutable,
    });
  if (distribution.kind === 'uv') {
    const python = await installPythonAgent({
      source: distribution.source,
      packageName: distribution.packageName,
      directory,
      runtimeRoot: options.runtimeRoot ?? join(directory, 'runtimes'),
      network,
      run: options.run,
      phase: options.phase,
      progress: options.progress,
      signal: options.signal,
    });
    return adapt(python.command, python.prefixArgs);
  }
  if (distribution.kind !== 'npm') {
    options.phase('downloading', '正在下载 ACP 程序…');
    const archive = join(directory, 'package.' + distribution.kind);
    await downloadPackageFile({
      source: distribution.source,
      destination: archive,
      network,
      sha256: distribution.sha256,
      progress: options.progress,
      signal: options.signal,
    });
    options.phase('installing', '正在安装并自动配置启动入口…');
    const extracted = join(directory, 'program');
    if (distribution.kind === 'zip') await extractAgentZip(archive, extracted, options.signal);
    else if (distribution.kind === 'tar') {
      const npm = npmRuntime(options.releaseRoot);
      if (!npm) throw new Error('Archive reader unavailable.');
      await extractAgentTar(archive, extracted, npm, options.signal);
    } else {
      const command = ownedPackagePath(extracted, distribution.cmd.replaceAll('\\', '/'));
      mkdirSync(dirname(command), { recursive: true });
      const { copyFileSync } = await import('node:fs');
      copyFileSync(archive, command);
    }
    rejectPackageLinks(extracted);
    const command = ownedPackagePath(extracted, distribution.cmd.replaceAll('\\', '/'));
    if (!lstatSync(command).isFile())
      throw new AgentPackageInstallError('程序包缺少目录声明的启动入口，未启动。');
    return adapt(command);
  }
  options.phase('installing', '正在通过 npm 下载依赖并安装 ACP 程序；此步骤不提供总下载量…');
  const cli = npmRuntime(options.releaseRoot);
  if (!cli) throw new AgentPackageInstallError('工作台缺少配套 npm，请使用完整发行包。');
  const effective = network.effective();
  const env = applyNetworkEnvironment(
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    effective,
  );
  if (effective.mode !== 'unmanaged') {
    env.npm_config_proxy = env.npm_config_https_proxy =
      effective.mode === 'proxy' ? effective.proxyUrl! : '';
    env.npm_config_noproxy = effective.bypass.join(',');
  }
  env.npm_config_cache = join(directory, 'cache');
  env.npm_config_registry = 'https://registry.npmjs.org/';
  const install = () =>
    (options.run ?? runInstallProcess)(
      process.execPath,
      [
        cli,
        'install',
        '--prefix',
        directory,
        '--global=false',
        '--workspaces=false',
        '--ignore-scripts',
        '--omit=dev',
        '--omit=optional',
        '--include=prod',
        '--package-lock=true',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        '--',
        distribution.source,
      ],
      {
        cwd: directory,
        windowsHide: true,
        timeout: 900_000,
        maxBuffer: 512_000,
        env,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  try {
    await install();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof InstallProcessError) || !error.retryable) throw error;
    options.phase('installing', '下载未完成，正在自动恢复安装…');
    await install();
  }
  options.signal?.throwIfAborted();
  await restoreNpmOptionalPackages({
    directory,
    npmCli: cli,
    network,
    phase: options.phase,
    progress: options.progress,
    signal: options.signal,
  });
  verifyNpmPlatformPackages(directory);
  const match = ExactPackage.exec(distribution.source)!;
  const packageRoot = ownedPackagePath(join(directory, 'node_modules'), match[1]!);
  const entries = installedPackageEntries(packageRoot, match[1]!, true);
  if (entries.length !== 1 || entries[0]!.packageVersion !== match[2])
    throw new AgentPackageInstallError(
      '安装包没有可自动确定的 ACP 入口，或版本不符。请使用已有本机入口。',
    );
  const bin = entries[0]!.script;
  const bindings = await adapterRuntimeEnvironment(match[1]!, directory, bin, options.signal);
  return /\.exe$/i.test(bin)
    ? adapt(bin)
    : adapt(options.nodeExecutable ?? process.execPath, [bin], bindings);
}
