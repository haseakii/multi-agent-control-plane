import { runInstallProcess } from './agent-install-process.js';
import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { AgentPackageInstallError } from './agent-package-error.js';
export { AgentPackageInstallError } from './agent-package-error.js';
export { downloadPackageFile, type DownloadProgress } from './agent-package-download.js';

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

/** No archive entry is treated as a shell command. */
export async function extractAgentZip(archive: string, destination: string, signal?: AbortSignal) {
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
  await runInstallProcess(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 120_000,
      ...(signal ? { signal } : {}),
      env: { ...process.env, CP_INSTALL_ARCHIVE: archive, CP_INSTALL_DESTINATION: destination },
    },
  );
}

/** Reuse the pinned npm distribution's tar reader; reject links and validate before extraction. */
export async function extractAgentTar(
  archive: string,
  destination: string,
  npmCli: string,
  signal?: AbortSignal,
) {
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
    await runInstallProcess(
      process.execPath,
      ['--input-type=module', '-e', script, archive, destination, npmCli],
      { windowsHide: true, timeout: 120_000, maxBuffer: 64_000, ...(signal ? { signal } : {}) },
    );
  } catch {
    signal?.throwIfAborted();
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
