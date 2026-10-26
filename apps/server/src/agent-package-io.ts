import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, readdirSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { NetworkSettingsService } from './network-settings.js';

export class AgentPackageInstallError extends Error {}

export function ownedPackagePath(root: string, name: string) {
  const result = resolve(root, name),
    rel = relative(root, result);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    isAbsolute(rel) ||
    win32.isAbsolute(name) ||
    /[\x00-\x1f:]/.test(name)
  )
    throw new AgentPackageInstallError('程序包路径越界，未解压或启动。');
  return result;
}

/** HTTPS downloads stay bounded and never forward credentials to redirect targets. */
export async function downloadPackageFile(options: {
  source: string;
  destination: string;
  network: Pick<NetworkSettingsService, 'fetch'>;
  sha256?: string | undefined;
  maxBytes?: number;
}) {
  let url = new URL(options.source),
    response: Response | undefined;
  const origin = url.origin,
    signal = AbortSignal.timeout(180_000);
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
      throw new AgentPackageInstallError('下载重定向不受支持，原文件保留。');
    response = await options.network.fetch(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Missing download redirect.');
    url = new URL(location, url);
  }
  if (!response?.ok || !response.body) throw new Error('Package download failed.');
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    new Transform({
      transform(block: Buffer, _encoding, callback) {
        bytes += block.byteLength;
        if (bytes > (options.maxBytes ?? 512 * 1024 * 1024)) {
          callback(new AgentPackageInstallError('程序包超过下载大小限制，未执行安装。'));
          return;
        }
        hash.update(block);
        callback(null, block);
      },
    }),
    createWriteStream(options.destination, { flags: 'wx' }),
  );
  if (!bytes || (options.sha256 && options.sha256.toLowerCase() !== hash.digest('hex')))
    throw new AgentPackageInstallError('程序包内容为空或 SHA-256 校验失败，未解压或启动。');
}

/** No archive entry is treated as a shell command. */
export async function extractAgentZip(archive: string, destination: string) {
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

/** Reuse the pinned npm distribution's tar reader; reject links and validate before extraction. */
export async function extractAgentTar(archive: string, destination: string, npmCli: string) {
  // A parser callback must never bring down the HTTP host. Keep decompression,
  // validation and extraction in a bounded child, using fixed code and argv.
  const script = [
    "import { createRequire } from 'node:module';",
    "import { mkdirSync } from 'node:fs';",
    "import { resolve,relative,isAbsolute,sep,win32 } from 'node:path';",
    'const [archive,destination,npmCli]=process.argv.slice(1);',
    "const tar=createRequire(npmCli)('tar');const seen=new Set();let total=0;",
    'await tar.t({file:archive,strict:true,onReadEntry(entry){',
    "const name=entry.path.replaceAll('\\\\','/').replace(/^\\.\\//,'').replace(/\\/$/,'');",
    "if((!name||name==='.')&&entry.type==='Directory')return;",
    'const rel=relative(destination,resolve(destination,name));const key=rel.toLowerCase();',
    "if(!rel||rel==='..'||name.split('/').includes('..')||rel.startsWith('..'+sep)||isAbsolute(rel)||win32.isAbsolute(name)||/[\\x00-\\x1f:]/.test(name))throw Error('Unsafe path');",
    "if(!['File','Directory'].includes(entry.type)||seen.has(key)||seen.size>=20000||!Number.isSafeInteger(entry.size)||entry.size<0||(total+=entry.size)>2147483648)throw Error('Unsupported archive entry');",
    'seen.add(key);}});if(!seen.size)throw Error("Empty or unsupported archive reader");',
    'mkdirSync(destination,{recursive:true});',
    'await tar.x({file:archive,cwd:destination,strict:true,preserveOwner:false});',
  ].join('\n');
  try {
    await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script, archive, destination, npmCli],
      { windowsHide: true, timeout: 120_000, maxBuffer: 64_000 },
    );
  } catch {
    throw new AgentPackageInstallError(
      '程序包含不支持的路径、链接、重复条目或超量内容，解压未完成。',
    );
  }
}

export function rejectPackageLinks(root: string, count = { value: 0 }) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (++count.value > 100000 || item.isSymbolicLink())
      throw new Error('Package tree contains unsupported entries.');
    if (item.isDirectory()) rejectPackageLinks(join(root, item.name), count);
  }
}
