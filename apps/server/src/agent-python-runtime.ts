import { runInstallProcess } from './agent-install-process.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { applyNetworkEnvironment, type NetworkSettingsService } from './network-settings.js';
import {
  AgentPackageInstallError,
  ownedPackagePath,
  downloadPackageFile,
  extractAgentZip,
  rejectPackageLinks,
  type DownloadProgress,
} from './agent-package-io.js';

export const MANAGED_UV_VERSION = '0.13.5';
export const MANAGED_PYTHON_REQUEST = '3.13';
const uvTargets = {
  x64: {
    name: 'uv-x86_64-pc-windows-msvc.zip',
    sha256: 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a',
  },
  arm64: {
    name: 'uv-aarch64-pc-windows-msvc.zip',
    sha256: '09f47edf90726084a70f9426f6e3ca4f46e9bf7cbf23b1716ec64d60b055fae3',
  },
} as const;
type Run = (
  command: string,
  args: string[],
  options: import('node:child_process').ExecFileOptions,
) => Promise<unknown>;
const UvRecord = z
  .object({ command: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export async function ensureManagedUv(
  root: string,
  network: NetworkSettingsService,
  progress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const target = uvTargets[process.arch as keyof typeof uvTargets];
  if (process.platform !== 'win32' || !target)
    throw new AgentPackageInstallError('此平台尚未提供自动 Python 运行环境。');
  const folder = join(root, 'uv', MANAGED_UV_VERSION),
    recordFile = join(folder, 'ready.json');
  if (existsSync(recordFile)) {
    const record = UvRecord.parse(JSON.parse(readFileSync(recordFile, 'utf8')));
    ownedPackagePath(folder, relative(folder, record.command));
    const canonical = realpathSync(record.command);
    ownedPackagePath(folder, relative(folder, canonical));
    // The only writable pointer is inside this private runtime directory.
    if (
      !record.command.toLowerCase().endsWith('\\uv.exe') ||
      createHash('sha256').update(readFileSync(record.command)).digest('hex') !== record.sha256
    )
      throw new AgentPackageInstallError('私有 Python 管理器完整性不符，原文件已保留。');
    return record.command;
  }
  const attempt = join(folder, randomUUID());
  mkdirSync(attempt, { recursive: true });
  const archive = join(attempt, target.name),
    program = join(attempt, 'program');
  await downloadPackageFile({
    source: `https://github.com/astral-sh/uv/releases/download/${MANAGED_UV_VERSION}/${target.name}`,
    destination: archive,
    network,
    sha256: target.sha256,
    maxBytes: 128 * 1024 * 1024,
    progress,
    signal,
  });
  await extractAgentZip(archive, program, signal);
  rejectPackageLinks(program);
  const command = join(program, 'uv.exe');
  const record = UvRecord.parse({
    command,
    sha256: createHash('sha256').update(readFileSync(command)).digest('hex'),
  });
  writeFileSync(recordFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return command;
}

export async function installPythonAgent(options: {
  source: string;
  packageName: string;
  directory: string;
  runtimeRoot: string;
  network: NetworkSettingsService;
  run?: Run | undefined;
  phase(state: 'downloading' | 'installing', message: string): void;
  uvExecutable?: string;
  progress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}) {
  const { directory, runtimeRoot, network } = options;
  options.signal?.throwIfAborted();
  options.phase('downloading', '正在准备 Python 环境管理器…');
  const uv =
    options.uvExecutable ??
    (await ensureManagedUv(runtimeRoot, network, options.progress, options.signal));
  options.phase('installing', '正在准备私有 Python 运行环境；此步骤不提供总下载量…');
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] => item[1] !== undefined && !/^(?:UV_|PIP_)/i.test(item[0]),
    ),
  );
  const env = applyNetworkEnvironment(inherited, network.effective());
  Object.assign(env, {
    UV_PYTHON_INSTALL_DIR: join(runtimeRoot, 'python'),
    UV_CACHE_DIR: join(runtimeRoot, 'cache'),
    UV_PYTHON_BIN_DIR: join(runtimeRoot, 'bin'),
    UV_TOOL_DIR: join(runtimeRoot, 'tools'),
    UV_NO_CONFIG: '1',
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    UV_LINK_MODE: 'copy',
  });
  const run = options.run ?? runInstallProcess;
  const commandOptions = {
    cwd: directory,
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 512_000,
    env,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  await run(
    uv,
    ['python', 'install', MANAGED_PYTHON_REQUEST, '--no-bin', '--no-registry', '--no-config'],
    commandOptions,
  );
  options.phase('installing', '正在创建独立 Python 环境…');
  const venv = join(directory, 'venv'),
    python = join(venv, 'Scripts/python.exe');
  await run(
    uv,
    [
      'venv',
      venv,
      '--python',
      MANAGED_PYTHON_REQUEST,
      '--managed-python',
      '--no-python-downloads',
      '--no-config',
    ],
    commandOptions,
  );
  options.phase('installing', '正在下载并安装 Python ACP 依赖；此步骤不提供总下载量…');
  await run(
    uv,
    [
      'pip',
      'install',
      '--python',
      python,
      '--only-binary',
      ':all:',
      '--no-config',
      '--index-url',
      'https://pypi.org/simple',
      options.source,
    ],
    commandOptions,
  );
  const inspect = [
    'import importlib.metadata as m,json,sys',
    `d=m.distribution(${JSON.stringify(options.packageName)})`,
    'print(json.dumps({"python":sys.version.split()[0],"entries":[e.name for e in d.entry_points if e.group=="console_scripts"]}))',
  ].join('\n');
  const output = (await run(python, ['-I', '-c', inspect], commandOptions)) as
    | { stdout?: string | Buffer }
    | undefined;
  const metadata = z
    .object({
      python: z.string().max(64),
      entries: z.array(z.string().min(1).max(256)).min(1).max(32),
    })
    .parse(JSON.parse(String(output?.stdout ?? '')));
  const normalize = (value: string) =>
    value.toLowerCase().replaceAll('_', '-').replaceAll('.', '-');
  const entry =
    metadata.entries.find((name) => normalize(name) === normalize(options.packageName)) ??
    (metadata.entries.length === 1 ? metadata.entries[0]! : undefined);
  if (!entry)
    throw new AgentPackageInstallError('Python 包有多个启动入口，无法自动确定 ACP 入口。');
  const script = join(directory, 'python-agent.py');
  writeFileSync(
    script,
    [
      'import importlib.metadata as m,sys',
      `e=next(e for e in m.distribution(${JSON.stringify(options.packageName)}).entry_points if e.group=="console_scripts" and e.name==${JSON.stringify(entry)})`,
      'sys.argv[0]=e.name',
      'sys.exit(e.load()())',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    join(directory, 'python-runtime.json'),
    JSON.stringify({ python: metadata.python, executable: python, package: options.source, entry }),
    { flag: 'wx', mode: 0o600 },
  );
  return { command: python, prefixArgs: [script] };
}
