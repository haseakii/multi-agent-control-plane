import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validatePackage } from './lib/installation.mjs';

// Build-side entry only. Uses the installed, locked dependencies; never installs software.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2),
  flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--web-dist'].includes(args[i]) || !args[i + 1] || flags[args[i]])
    throw Error(
      'Usage: node scripts/publish.mjs --output NEW_DIRECTORY [--web-dist VERIFIED_WEB_DIRECTORY]',
    );
  flags[args[i]] = args[i + 1];
}
if (!flags['--output']) throw Error('请选择新的发布目录。');
const output = path.resolve(flags['--output']);
if (fs.existsSync(output)) throw Error('发布目录已存在，已保留原文件。');
function run(entry, args) {
  execFileSync(process.execPath, [entry, ...args], {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
  });
}
const packages = [
  'core',
  'storage',
  'runner',
  'acp-runtime',
  'policy',
  'task-engine',
  'message-router',
  'artifact-store',
  'fleet-mcp',
  'workspace',
];
for (const name of packages)
  run('node_modules/typescript/bin/tsc', ['-p', 'packages/' + name + '/tsconfig.json']);
for (const name of ['server', 'web'])
  run('node_modules/typescript/bin/tsc', ['-p', 'apps/' + name + '/tsconfig.json']);
const evidence = output + '-validation';
fs.mkdirSync(evidence, { recursive: true });
run('node_modules/vitest/vitest.mjs', [
  'run',
  '--maxWorkers=4',
  '--reporter=json',
  '--outputFile=' + path.join(evidence, 'tests.json'),
]);
let web = flags['--web-dist'] ? path.resolve(flags['--web-dist']) : output + '-web';
if (!flags['--web-dist']) {
  run('integrations/hermes-workbench/build.mjs', ['--typecheck']);
  run('integrations/hermes-workbench/build.mjs', ['--output', web]);
}
run('scripts/verify-hermes-usability.mjs', [
  '--web-root',
  web,
  '--evidence',
  path.join(evidence, 'hermes-usability'),
]);
run('scripts/build-windows-release.mjs', [
  '--output',
  output,
  '--workbench',
  'hermes',
  '--web-dist',
  web,
]);
const verified = validatePackage(output);
run('scripts/verify-windows-installation.mjs', [
  '--directory',
  output,
  '--evidence',
  path.join(evidence, 'first-install'),
]);
fs.writeFileSync(
  path.join(evidence, 'release.json'),
  JSON.stringify(
    { releaseId: verified.releaseId, files: verified.manifest.files.length, tests: 'tests.json' },
    null,
    2,
  ),
);
console.log('发布包已验证：' + output + '\n版本：' + verified.releaseId.slice(0, 12));
