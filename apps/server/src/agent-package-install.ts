import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { installedPackageEntries } from './agent-installed-package.js';
import type { CatalogEntry } from './agent-catalog.js';
import { applyNetworkEnvironment, type NetworkSettingsService } from './network-settings.js';
import { TaskControlError } from './task-control.js';

const ExactPackage =
  /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/;
export function packagePlan(entry: CatalogEntry, platform: string, npmAvailable: boolean) {
  const binary =
    entry.distribution.binary?.[
      platform as keyof NonNullable<CatalogEntry['distribution']['binary']>
    ];
  let distribution;
  if (
    binary &&
    platform.startsWith('windows-') &&
    new URL(binary.archive).pathname.endsWith('.zip') &&
    !Object.keys(binary.env ?? {}).length
  ) {
    if (new URL(binary.archive).protocol !== 'https:')
      throw new TaskControlError(409, '此产品下载地址不支持安全安装。');
    distribution = {
      kind: 'zip' as const,
      source: binary.archive,
      cmd: binary.cmd,
      args: binary.args ?? [],
      sha256: binary.sha256?.toLowerCase(),
    };
  } else if (
    entry.distribution.npx &&
    npmAvailable &&
    !Object.keys(entry.distribution.npx.env ?? {}).length &&
    ExactPackage.test(entry.distribution.npx.package)
  ) {
    distribution = {
      kind: 'npm' as const,
      source: entry.distribution.npx.package,
      args: entry.distribution.npx.args ?? [],
    };
  } else
    throw new TaskControlError(
      409,
      '此产品暂不支持隔离安装：需要本平台 ZIP 或固定版本 npm 包。仍可选择本机已有入口。',
    );
  const plan = { entryId: entry.id, name: entry.name, version: entry.version, distribution };
  return {
    ...plan,
    planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    integrity:
      distribution.kind === 'zip'
        ? distribution.sha256
          ? 'sha256'
          : 'https-source'
        : 'npm-integrity',
    source: distribution.source,
  };
}
export type PackagePlan = ReturnType<typeof packagePlan>;
export class AgentPackageInstallError extends Error {}
const ownedPath = (root: string, name: string) => {
  const result = resolve(root, name),
    rel = relative(root, result);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    isAbsolute(rel) ||
    /^[A-Za-z]:/.test(name) ||
    name.includes('\0')
  )
    throw new Error('Package path escapes installation.');
  return result;
};
export function npmRuntime(root: string) {
  const candidates = [
    join(root, 'runtime/npm/bin/npm-cli.js'),
    join(process.execPath, '../node_modules/npm/bin/npm-cli.js'),
  ];
  return candidates.find(existsSync);
}

/** Only archive extraction is Windows-specific; it never evaluates catalog text as code. */
async function extractZip(archive: string, destination: string) {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$zip=[IO.Compression.ZipFile]::OpenRead($env:CP_INSTALL_ARCHIVE)',
    'try {',
    '$total=0L; $seen=@{}',
    'if($zip.Entries.Count -gt 20000){throw "Too many entries"}',
    'foreach($entry in $zip.Entries){',
    '$name=$entry.FullName.Replace("\\","/")',
    'if([IO.Path]::IsPathRooted($name) -or $name.Contains(":") -or $name.Split("/").Contains("..") -or $name.Contains([char]0)){throw "Unsafe archive path"}',
    'if(($entry.ExternalAttributes -band 0x400) -ne 0 -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw "Archive link rejected"}',
    '$key=$name.ToLowerInvariant(); if($seen.ContainsKey($key)){throw "Duplicate archive entry"};$seen[$key]=$true',
    '$total+=$entry.Length;if($total -gt 2147483648){throw "Archive too large"}',
    '}',
    '[IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip,$env:CP_INSTALL_DESTINATION)',
    '} finally {$zip.Dispose()}',
  ].join('\n');
  await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env, CP_INSTALL_ARCHIVE: archive, CP_INSTALL_DESTINATION: destination },
    },
  );
}
function rejectTreeLinks(root: string, count = { value: 0 }) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (++count.value > 100000 || item.isSymbolicLink())
      throw new Error('Package tree contains unsupported entries.');
    if (item.isDirectory()) rejectTreeLinks(join(root, item.name), count);
  }
}
export async function installAgentPackage(options: {
  plan: PackagePlan;
  directory: string;
  releaseRoot: string;
  network: NetworkSettingsService;
  nodeExecutable?: string;
  run?: (
    command: string,
    args: string[],
    options: import('node:child_process').ExecFileOptions,
  ) => Promise<unknown>;
  phase: (state: 'downloading' | 'installing', message: string) => void;
}) {
  const { plan, directory, network } = options;
  // A retry uses a fresh attempt directory; partial archives remain as failure evidence.
  mkdirSync(directory, { recursive: true });
  const distribution = plan.distribution;
  if (distribution.kind === 'zip') {
    options.phase('downloading', '正在通过工作台网络设置下载程序包…');
    let url = new URL(distribution.source),
      response: Response | undefined;
    const origin = url.origin;
    const controller = AbortSignal.timeout(180_000);
    for (let hop = 0; hop < 6; hop++) {
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.origin !== origin &&
          ![
            'release-assets.githubusercontent.com',
            'objects.githubusercontent.com',
            'github.com',
          ].includes(url.hostname))
      )
        throw new Error('Download redirect refused.');
      response = await network.fetch(url, { redirect: 'manual', signal: controller });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Missing redirect.');
      url = new URL(location, url);
    }
    if (!response?.ok || !response.body) throw new Error('Download failed.');
    const archive = join(directory, 'package.zip');
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      new Transform({
        transform(block: Buffer, _encoding, callback) {
          bytes += block.byteLength;
          if (bytes > 512 * 1024 * 1024) {
            callback(new AgentPackageInstallError('程序包超过 512 MB 限制，未执行安装。'));
            return;
          }
          hash.update(block);
          callback(null, block);
        },
      }),
      createWriteStream(archive, { flags: 'wx' }),
    );
    if (!bytes || (distribution.sha256 && distribution.sha256 !== hash.digest('hex')))
      throw new AgentPackageInstallError(
        '程序包内容为空或 SHA-256 校验失败，未解压或启动。请刷新目录后重试。',
      );
    options.phase('installing', '正在解压并检查本机启动入口…');
    const extracted = join(directory, 'program');
    await extractZip(archive, extracted);
    rejectTreeLinks(extracted);
    const command = ownedPath(extracted, distribution.cmd.replaceAll('\\', '/'));
    if (!lstatSync(command).isFile() || !command.toLowerCase().endsWith('.exe'))
      throw new Error('Missing executable.');
    return { type: 'acp-stdio' as const, command, args: distribution.args };
  }
  options.phase('installing', '正在安装固定版本适配器及依赖，安装脚本已禁用…');
  const cli = npmRuntime(options.releaseRoot);
  if (!cli) throw new Error('Bundled npm unavailable.');
  const effective = network.effective();
  const env = applyNetworkEnvironment(
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    effective,
  );
  // npm also reads its own proxy configuration. Managed choices override inherited npmrc.
  if (effective.mode !== 'unmanaged') {
    env.npm_config_proxy = env.npm_config_https_proxy =
      effective.mode === 'proxy' ? effective.proxyUrl! : '';
    env.npm_config_noproxy = effective.bypass.join(',');
  }
  env.npm_config_cache = join(directory, 'cache');
  env.npm_config_registry = 'https://registry.npmjs.org/';
  await (options.run ?? promisify(execFile))(
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
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--',
      distribution.source,
    ],
    { windowsHide: true, timeout: 300_000, maxBuffer: 512_000, env },
  );
  const match = ExactPackage.exec(distribution.source)!;
  const packageRoot = ownedPath(join(directory, 'node_modules'), match[1]!);
  const entries = installedPackageEntries(packageRoot, match[1]!);
  if (entries.length !== 1 || entries[0]!.packageVersion !== match[2])
    throw new AgentPackageInstallError(
      '安装包没有唯一可用的 JavaScript ACP 入口，或版本不符。请使用已有本机入口。',
    );
  const bin = entries[0]!.script;
  return {
    type: 'acp-stdio' as const,
    command: options.nodeExecutable ?? process.execPath,
    args: [bin, ...distribution.args],
  };
}
