import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validatePackage } from './lib/installation.mjs';

const args = process.argv.slice(2);
if (
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  args.length !== 4 ||
  args[0] !== '--package' ||
  args[2] !== '--output'
)
  throw Error(
    'Usage: node scripts/build-windows-executable.mjs --package VERIFIED_PACKAGE --output NEW.exe (Windows x64)',
  );
const pack = validatePackage(path.resolve(args[1])),
  output = path.resolve(args[3]);
if (
  !output.toLowerCase().endsWith('.exe') ||
  fs.existsSync(output) ||
  fs.existsSync(output + '.build')
)
  throw Error('Choose a fresh EXE output; existing files are preserved.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = output + '.build';
fs.mkdirSync(build, { recursive: true });
const archive = path.join(build, 'payload.zip'),
  list = path.join(build, 'files.json');
fs.writeFileSync(
  list,
  JSON.stringify([...pack.manifest.files.map((item) => item.path), 'release-manifest.json'].sort()),
);
const system = process.env.SystemRoot ?? 'C:/Windows';
const script = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  'Add-Type -AssemblyName System.IO.Compression',
  '$files=Get-Content -LiteralPath $env:CP_BUILD_LIST -Raw -Encoding UTF8 | ConvertFrom-Json',
  '$stream=[IO.File]::Open($env:CP_BUILD_PAYLOAD,[IO.FileMode]::CreateNew)',
  '$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create)',
  'try { foreach($name in $files){$file=[IO.Path]::Combine($env:CP_BUILD_PACKAGE,$name);[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file,$name,[IO.Compression.CompressionLevel]::Optimal)|Out-Null} } finally {$zip.Dispose();$stream.Dispose()}',
].join('\n');
execFileSync(
  path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  {
    windowsHide: true,
    timeout: 300000,
    env: {
      ...process.env,
      CP_BUILD_LIST: list,
      CP_BUILD_PACKAGE: pack.root,
      CP_BUILD_PAYLOAD: archive,
    },
  },
);
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const payloadSha256 = hash(archive);
const constants = path.join(build, 'PayloadInfo.cs');
fs.writeFileSync(
  constants,
  [
    'using System.Reflection;',
    '[assembly:AssemblyTitle("Hermes 工作台")]',
    '[assembly:AssemblyVersion("0.1.0.0")]',
    '[assembly:System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8",FrameworkDisplayName=".NET Framework 4.8")]',
    `internal static class PayloadInfo { internal const string ReleaseId="${pack.releaseId}"; internal const string PayloadSha256="${payloadSha256}"; internal const string NodeSha256="${pack.manifest.nodeSha256}"; }`,
  ].join('\n'),
);
const compiler = path.join(system, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
if (!fs.existsSync(compiler))
  throw Error(
    'The Windows .NET Framework C# compiler is required on the build host. No compiler was downloaded.',
  );
const compile = execFileSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/debug-',
    '/utf8output',
    '/codepage:65001',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Runtime.Serialization.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    '/win32manifest:' + path.join(repo, 'scripts/windows/launcher.manifest'),
    '/resource:' + archive + ',Hermes.Payload.zip',
    '/out:' + output,
    path.join(repo, 'scripts/windows/WorkbenchLauncher.cs'),
    constants,
  ],
  { windowsHide: true, encoding: 'utf8', timeout: 120000 },
);
if (compile.trim()) console.log(compile.trim());
const report = {
  format: 'windows-self-contained-exe-v1',
  releaseId: pack.releaseId,
  files: pack.manifest.files.length + 1,
  payloadSha256,
  sha256: hash(output),
  bytes: fs.statSync(output).size,
  target: 'Windows 10/11 x64 with built-in .NET Framework 4.8',
  requiresSystemNode: false,
  requiresAdministrator: false,
  signature: 'unsigned',
};
fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report }));
