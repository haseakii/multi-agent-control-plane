import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('M1 builder supports the verified Windows x64 host only.');
if (
  ![2, 6].includes(args.length) ||
  args[0] !== '--output' ||
  (args.length === 6 &&
    (args[2] !== '--workbench' || args[3] !== 'hermes' || args[4] !== '--web-dist' || !args[5]))
)
  throw new Error(
    'Usage: node scripts/build-windows-release.mjs --output NEW_DIRECTORY [--workbench hermes --web-dist PRIVATE_WEB_DIRECTORY]',
  );
const hermes = args.length === 6;
const output = resolve(args[1]);
if (existsSync(output))
  throw new Error(
    'Release output already exists; choose a fresh directory. No files were removed.',
  );
const nodeSource = realpathSync(process.execPath);
const nodeLicense = join(dirname(nodeSource), 'LICENSE');
const expectedNodeVersion = 'v22.22.2';
if (process.version !== expectedNodeVersion)
  throw new Error(
    `Expected pinned Node ${expectedNodeVersion}, got ${process.version}. No runtime was downloaded.`,
  );
const powershell = join(
  process.env.SystemRoot ?? 'C:/Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
const signatureCommand =
  "Get-AuthenticodeSignature -LiteralPath $env:CONTROL_PLANE_NODE_TO_VERIFY | Select-Object @{Name='status';Expression={[string]$_.Status}},@{Name='signer';Expression={$_.SignerCertificate.Subject}},@{Name='thumbprint';Expression={$_.SignerCertificate.Thumbprint}} | ConvertTo-Json -Compress";
const nodeSignature = JSON.parse(
  execFileSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', signatureCommand],
    {
      encoding: 'utf8',
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
        CONTROL_PLANE_NODE_TO_VERIFY: nodeSource,
      },
    },
  ).trim(),
);
if (
  nodeSignature.status !== 'Valid' ||
  !/(^|,\s*)O=OpenJS Foundation(,|$)/.test(nodeSignature.signer ?? '') ||
  !/(^|,\s*)CN=OpenJS Foundation(,|$)/.test(nodeSignature.signer ?? '')
)
  throw new Error('Node must have a valid OpenJS Foundation signature. No runtime was downloaded.');
const repositoryLicense = join(repo, 'LICENSE');
if (
  !existsSync(repositoryLicense) ||
  !readFileSync(repositoryLicense, 'utf8').includes('Apache License')
)
  throw new Error('Repository Apache LICENSE is missing or invalid.');
const webDist = hermes ? realpathSync(resolve(args[5])) : join(repo, 'apps/web/dist');
if (
  hermes &&
  webDist.toLowerCase() === resolve(repo, '.run/hermes-integration/web-dist').toLowerCase()
)
  throw new Error('Use a private new Hermes Web build, not the active development web-dist.');
for (const local of [relative(webDist, output), relative(output, webDist)])
  if (local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)))
    throw new Error('Web input and release output directories must not overlap.');
let workbench;
let upstream;
if (hermes) {
  const { ReleaseWorkbenchSchema } = await import('../apps/server/dist/release-workbench.js');
  workbench = ReleaseWorkbenchSchema.parse(
    JSON.parse(readFileSync(join(webDist, 'workbench.json'), 'utf8')),
  );
  upstream = JSON.parse(readFileSync(join(webDist, 'build-provenance.json'), 'utf8'));
  if (
    upstream.upstream !== 'Eynzof/Hermes-CN-Desktop' ||
    upstream.commit !== '06e15d0e5d3c27f1fd37f09579f26f91c020036e' ||
    upstream.builtAt !== workbench.uiBuildId
  )
    throw new Error('Hermes build provenance does not match the selected workbench.');
  if (!readFileSync(join(webDist, 'LICENSE-HERMES.txt'), 'utf8').trim())
    throw new Error(
      'Hermes upstream license is missing. Local evaluation only; no distribution authorization is implied.',
    );
}
const frontend = JSON.parse(readFileSync(join(webDist, 'frontend-dependencies.json'), 'utf8'));
if (
  frontend.version !== 1 ||
  !Array.isArray(frontend.dependencies) ||
  !frontend.dependencies.length ||
  !Array.isArray(frontend.bundles) ||
  !frontend.bundles.length
)
  throw new Error('Frontend build license inventory missing; rebuild the web app.');
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const item of [
  frontend.notices,
  ...frontend.bundles,
  ...frontend.dependencies.map((item) => ({ file: item.file, sha256: item.sha256 })),
]) {
  const target = resolve(webDist, item.file),
    local = relative(webDist, target);
  if (
    local === '..' ||
    local.startsWith(`..${sep}`) ||
    !existsSync(target) ||
    digest(target) !== item.sha256
  )
    throw new Error('Frontend license/bundle inventory does not match its files.');
}
for (const name of ['react', 'react-dom', 'scheduler'])
  if (!frontend.dependencies.some((item) => item.name === name))
    throw new Error(`Frontend license inventory missing ${name}`);
if (!existsSync(join(webDist, 'THIRD-PARTY-NOTICES.txt')))
  throw new Error('Full frontend third-party notices are missing.');

if (!existsSync(nodeLicense))
  throw new Error(
    'Existing Node runtime LICENSE is missing; supply a complete official local Node distribution first.',
  );
const pkg = (directory) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
function locate(name, from) {
  const request = createRequire(join(from, 'package.json'));
  for (const modules of request.resolve.paths(name) ?? []) {
    const directory = join(modules, name);
    if (existsSync(join(directory, 'package.json'))) return realpathSync(directory);
  }
  throw new Error(`Installed dependency is missing: ${name} from ${relative(repo, from)}`);
}
const graph = new Map();
const roots = new Map();
function discover(source) {
  if (graph.has(source)) return;
  const manifest = pkg(source);
  const dependencies = new Map();
  graph.set(source, { manifest, dependencies });
  for (const [name] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })) {
    let child;
    try {
      child = locate(name, source);
    } catch (error) {
      if (
        name in (manifest.optionalDependencies ?? {}) ||
        manifest.peerDependenciesMeta?.[name]?.optional
      )
        continue;
      throw error;
    }
    dependencies.set(name, child);
    if (!roots.has(name)) roots.set(name, child);
    discover(child);
  }
}
const server = join(repo, 'apps/server');
discover(server);
mkdirSync(output, { recursive: true });
const inventory = [];

function copyTree(
  source,
  destination,
  external = false,
  boundary = source,
  productionDist = false,
) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (
      productionDist &&
      (['fixtures', '__tests__'].includes(entry.name) ||
        /\.(?:test|spec)\.(?:[cm]?js(?:\.map)?|d\.ts(?:\.map)?)$/.test(entry.name))
    )
      continue;
    if (
      external &&
      (['node_modules', '.git', '.codex', '.npmrc'].includes(entry.name) ||
        entry.name === '.env' ||
        entry.name.startsWith('.env.'))
    )
      continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const canonical = realpathSync(from);
    const local = relative(boundary, canonical);
    if (local === '..' || local.startsWith(`..${sep}`))
      throw new Error(`Package link escapes its source: ${from}`);
    if (statSync(canonical).isDirectory())
      copyTree(canonical, to, external, boundary, productionDist);
    else copyFileSync(canonical, to);
  }
}

function copyPackage(source, destination, ancestors = new Map()) {
  const { manifest, dependencies } = graph.get(source);
  mkdirSync(destination, { recursive: true });
  const localSource = relative(repo, source);
  const workspace =
    !localSource.startsWith('..') && !localSource.split(sep).includes('node_modules');
  if (manifest.name.startsWith('@control-plane/') && !workspace)
    throw new Error(`Workspace path was misclassified: ${source} relative to ${repo}`);
  if (workspace) {
    copyTree(join(source, 'dist'), join(destination, 'dist'), false, join(source, 'dist'), true);
    writeFileSync(
      join(destination, 'package.json'),
      JSON.stringify({ ...manifest, scripts: undefined, devDependencies: undefined }, null, 2),
    );
    if (manifest.name === '@control-plane/storage')
      copyTree(join(source, 'drizzle'), join(destination, 'drizzle'));
  } else {
    copyTree(source, destination, true);
  }
  inventory.push({
    name: manifest.name,
    version: manifest.version,
    kind: workspace ? 'workspace' : 'external',
    path: relative(output, destination).split(sep).join('/'),
  });
  const chain = new Map(ancestors).set(manifest.name, source);
  for (const [name, child] of dependencies) {
    if (roots.get(name) === child || chain.get(name) === child) continue;
    copyPackage(child, join(destination, 'node_modules', name), chain);
  }
}
for (const [name, source] of roots) copyPackage(source, join(output, 'node_modules', name));
copyPackage(server, join(output, 'apps/server'));
copyFileSync(
  join(repo, 'apps/server/src/windows-lock-delete.cs'),
  join(output, 'apps/server/dist/windows-lock-delete.cs'),
);
copyTree(webDist, join(output, 'apps/web/dist'));
copyFileSync(repositoryLicense, join(output, 'LICENSE'));
if (existsSync(join(repo, 'NOTICE'))) copyFileSync(join(repo, 'NOTICE'), join(output, 'NOTICE'));
copyFileSync(join(webDist, 'THIRD-PARTY-NOTICES.txt'), join(output, 'THIRD-PARTY-NOTICES.txt'));
if (hermes) copyFileSync(join(webDist, 'LICENSE-HERMES.txt'), join(output, 'LICENSE-HERMES.txt'));
mkdirSync(join(output, 'runtime'));
copyFileSync(nodeSource, join(output, 'runtime/node.exe'));
copyFileSync(nodeLicense, join(output, 'runtime/LICENSE'));
// Reuse the npm shipped with the verified local Node distribution. No package
// manager is installed globally; member installs stay under installation/agents.
const bundledNpm = join(dirname(nodeSource), 'node_modules/npm');
if (existsSync(join(bundledNpm, 'bin/npm-cli.js'))) {
  copyTree(bundledNpm, join(output, 'runtime/npm'));
  // npm's own wrappers expect a global layout. Call the pinned CLI directly,
  // without resolving the user's global npm prefix or another Node version.
  for (const command of ['npm', 'npx'])
    writeFileSync(
      join(output, 'runtime', command + '.cmd'),
      [
        '@echo off',
        '"%~dp0node.exe" "%~dp0npm\\bin\\' + command + '-cli.js" %*',
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'),
    );
}
writeFileSync(
  join(output, 'package.json'),
  JSON.stringify(
    {
      private: true,
      type: 'module',
      name: 'control-plane-windows-release',
      version: pkg(repo).version,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(output, 'config.json'),
  JSON.stringify({ version: 1, port: 3000, dataDir: './data', logLevel: 'info' }, null, 2),
);
const slash = String.fromCharCode(92);
const launcher = [
  '@echo off',
  'setlocal',
  'for /f "tokens=2 delims=:" %%a in (\'chcp\') do set "_CP_CODEPAGE=%%a"',
  'chcp 65001 >nul',
  'if not exist "%~dp0runtime\\node.exe" (',
  '  echo CP_RUNTIME_MISSING: runtime\\node.exe',
  '  if exist "%~dp0STARTUP-HELP.zh-CN.txt" type "%~dp0STARTUP-HELP.zh-CN.txt"',
  '  echo.',
  '  set "_CP_EXIT=127"',
  '  goto finish',
  ')',
  'if not exist "%~dp0apps\\server\\dist\\release-main.js" (',
  '  echo CP_ENTRY_MISSING: apps\\server\\dist\\release-main.js',
  '  if exist "%~dp0STARTUP-HELP.zh-CN.txt" type "%~dp0STARTUP-HELP.zh-CN.txt"',
  '  echo.',
  '  set "_CP_EXIT=2"',
  '  goto finish',
  ')',
  '"%~dp0runtime\\node.exe" "%~dp0apps\\server\\dist\\release-main.js" %*',
  'set "_CP_EXIT=%errorlevel%"',
  ':finish',
  'if not "%_CP_EXIT%"=="0" if not defined CONTROL_PLANE_NO_PAUSE pause',
  'if defined _CP_CODEPAGE chcp %_CP_CODEPAGE% >nul',
  'exit /b %_CP_EXIT%',
  '',
].join(String.fromCharCode(13, 10));
writeFileSync(join(output, 'start.cmd'), launcher);
mkdirSync(join(output, 'launcher/lib'), { recursive: true });
for (const file of ['control-plane.mjs', 'installed-entry.mjs'])
  copyFileSync(join(repo, 'scripts', file), join(output, 'launcher', file));
copyFileSync(
  join(repo, 'scripts/lib/installation.mjs'),
  join(output, 'launcher/lib/installation.mjs'),
);
copyFileSync(
  join(repo, 'scripts/lib/package-open.mjs'),
  join(output, 'launcher/lib/package-open.mjs'),
);
for (const [name, command] of [
  ['打开工作台.cmd', 'open-package'],
  ['升级工作台.cmd', 'update'],
]) {
  const args =
    command === 'open-package'
      ? 'open-package --release "%~dp0." --upgrade-if-newer'
      : 'update --installation "%LOCALAPPDATA%\\MultiAgentControlPlane\\installation.json" --release "%~dp0."';
  writeFileSync(
    join(output, name),
    [
      '@echo off',
      'setlocal',
      'chcp 65001 >nul',
      '"%~dp0runtime\\node.exe" "%~dp0launcher\\control-plane.mjs" ' + args + ' %*',
      'set "_CP_EXIT=%errorlevel%"',
      'if not "%_CP_EXIT%"=="0" (',
      '  echo CP_LAUNCH_FAILED: %_CP_EXIT%',
      '  if exist "%~dp0STARTUP-HELP.zh-CN.txt" type "%~dp0STARTUP-HELP.zh-CN.txt"',
      ')',
      'if not "%_CP_EXIT%"=="0" if not defined CONTROL_PLANE_NO_PAUSE pause',
      'exit /b %_CP_EXIT%',
      '',
    ].join('\r\n'),
  );
}
copyFileSync(join(repo, 'scripts/release-RUN.txt'), join(output, 'RUN.txt'));
copyFileSync(
  join(repo, 'scripts/release-startup-help.txt'),
  join(output, 'STARTUP-HELP.zh-CN.txt'),
);
// Verify installed native SQLite + migrations and the relative Fleet child entry in isolation.
const probe = `import {openSqliteStorage} from '@control-plane/storage';import {getFleetMcpStdioProxyPath} from '@control-plane/fleet-mcp';import {existsSync} from 'node:fs';import {relative} from 'node:path';const s=openSqliteStorage({filename:':memory:'});if(!existsSync(getFleetMcpStdioProxyPath()))throw Error('Fleet proxy missing');console.log(JSON.stringify({sqlite:s.sqlite.prepare('select sqlite_version() as version').get(),migrations:s.sqlite.prepare('select count(*) as count from __drizzle_migrations').get(),proxy:relative(process.cwd(),getFleetMcpStdioProxyPath())}));s.close();`;
const result = execFileSync(
  join(output, 'runtime/node.exe'),
  ['--input-type=module', '-e', probe],
  { cwd: output, encoding: 'utf8' },
);
const manifest = {
  format: 'windows-directory-m1',
  builtAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  expectedNodeVersion,
  nodeSignature,
  repositoryLicense: { file: 'LICENSE', sha256: digest(repositoryLicense) },
  frontend,
  ...(hermes
    ? {
        workbench,
        upstream,
        usage: 'private-local-evaluation',
        workbenchSha256: digest(join(webDist, 'workbench.json')),
        provenanceSha256: digest(join(webDist, 'build-provenance.json')),
        upstreamLicenseSha256: digest(join(webDist, 'LICENSE-HERMES.txt')),
      }
    : {}),
  nodeSha256: createHash('sha256').update(readFileSync(nodeSource)).digest('hex'),
  dependencies: inventory,
  probe: JSON.parse(result.trim()),
};
const inventoryFiles = [];
function inventoryDirectory(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name,
      full = join(directory, entry.name);
    if (entry.isDirectory()) inventoryDirectory(full, name + '/');
    else if (entry.isFile())
      inventoryFiles.push({ path: name, size: statSync(full).size, sha256: digest(full) });
    else throw Error('Release contains a non-regular entry.');
  }
}
inventoryDirectory(output);
manifest.files = inventoryFiles;
writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify(
    { output, packages: inventory.length, nativeAndMigrationProbe: manifest.probe },
    null,
    2,
  ),
);
