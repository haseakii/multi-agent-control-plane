import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readJson, validatePackage } from './lib/installation.mjs';

const args = process.argv.slice(2);
assert(
  process.platform === 'win32' &&
    [4, 6].includes(args.length) &&
    args[0] === '--executable' &&
    args[2] === '--evidence' &&
    (args.length === 4 || args[4] === '--previous'),
  'Usage: node scripts/verify-windows-executable.mjs --executable BUILT.exe --evidence NEW_DIRECTORY [--previous VERIFIED_OLD_PACKAGE]',
);
const executable = path.resolve(args[1]),
  root = path.resolve(args[3]),
  metadata = readJson(executable + '.json');
assert(!fs.existsSync(root), 'Keep previous evidence; choose a new directory.');
assert.match(metadata.releaseId, /^[a-f0-9]{64}$/);
fs.mkdirSync(root, { recursive: true });
const download = path.join(root, '只下载这一个 文件 & 中文'),
  installed = path.join(root, '中文 用户安装'),
  cache = path.join(root, '私有 程序缓存');
fs.mkdirSync(download);
const onlyExe = path.join(download, '工作台.exe');
fs.copyFileSync(executable, onlyExe);
assert.deepEqual(fs.readdirSync(download), ['工作台.exe']);
const system = process.env.SystemRoot ?? 'C:/Windows';
const environment = {
  ...process.env,
  PATH: [
    path.join(system, 'System32'),
    system,
    path.join(system, 'System32/WindowsPowerShell/v1.0'),
  ].join(';'),
  NODE_OPTIONS: '--require nonexistent-ambient-node-hook',
  NPM_CONFIG_PREFIX: path.join(root, 'unrelated broken prefix'),
};
delete environment.CONTROL_PLANE_DEPLOYMENT_CONTEXT;
const run = promisify(execFile),
  checks = [],
  installations = new Set(),
  servers = [];
let failure;
let invocation = 0;
async function invoke(file, directory, extra = []) {
  const sequence = invocation++;
  const result = await run(
    file,
    ['--headless', '--no-shortcuts', '--directory', directory, '--cache', cache, ...extra],
    { cwd: download, windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024, env: environment },
  );
  fs.writeFileSync(
    path.join(root, 'invocation-' + sequence + '.log'),
    result.stdout + result.stderr,
  );
  return result;
}
function settings(directory) {
  const state = readJson(path.join(directory, 'installation.json')),
    config = readJson(state.current.configFile);
  return {
    state,
    config,
    base: `http://127.0.0.1:${config.port}`,
    data: path.resolve(path.dirname(state.current.configFile), config.dataDir),
  };
}
async function json(base, route, body) {
  const response = await fetch(base + route, {
    signal: AbortSignal.timeout(10000),
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  assert(response.ok, route + ': ' + response.status);
  return response.json();
}
try {
  const conflict = createServer();
  const listening = await new Promise((done) => {
    conflict.once('error', (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      done(false);
    });
    conflict.listen(3000, '127.0.0.1', () => done(true));
  });
  if (listening) servers.push(conflict);
  installations.add(installed);
  await invoke(onlyExe, installed);
  const first = settings(installed);
  assert.notEqual(first.config.port, 3000);
  assert.equal((await json(first.base, '/health')).deployment.releaseId, metadata.releaseId);
  const snapshot = await json(first.base, '/api/control-center');
  assert.equal(snapshot.agents.length, 0);
  assert.equal(snapshot.executionAttempts.length, 0);
  checks.push(
    'A single EXE under a Unicode/special-character download path installs with no system Node, ignores ambient Node hooks and selects a free private port',
  );
  await json(first.base, '/api/projects', { id: 'native-proof', name: '保留的项目' });
  const pid = readJson(path.join(first.data, 'instance.lock')).pid;
  const alias = path.join(installed, '工作台.exe');
  fs.writeFileSync(alias, 'old launcher fixture; never executed');
  await Promise.all([invoke(onlyExe, installed), invoke(onlyExe, installed)]);
  assert.equal(createHash('sha256').update(fs.readFileSync(alias)).digest('hex'), metadata.sha256);
  const previousAlias = fs
    .readdirSync(installed)
    .find((name) => name.startsWith('工作台.exe.previous-'));
  assert(previousAlias);
  assert.equal(
    fs.readFileSync(path.join(installed, previousAlias), 'utf8'),
    'old launcher fixture; never executed',
  );
  assert.equal(settings(installed).state.id, first.state.id);
  assert.equal(readJson(path.join(first.data, 'instance.lock')).pid, pid);
  assert.equal(
    fs.readFileSync(path.join(cache, 'packages', metadata.releaseId + '.ready'), 'utf8'),
    metadata.releaseId,
  );
  assert.equal(
    fs
      .readdirSync(path.join(cache, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length,
    1,
  );
  assert(
    (await json(first.base, '/api/control-center')).projects.some(
      (project) => project.id === 'native-proof',
    ),
  );
  checks.push(
    'Repeated and concurrent opens reuse the same instance and preserve existing projects',
  );
  fs.renameSync(onlyExe, onlyExe + '.kept');
  const entry = path.join(installed, '工作台.exe');
  assert(fs.existsSync(entry));
  await invoke(entry, installed);
  checks.push('The installed EXE works after the original download has been renamed');
  const cached = path.join(cache, 'packages', metadata.releaseId);
  fs.writeFileSync(path.join(cached, 'RUN.txt'), 'incomplete cache fixture');
  await invoke(entry, installed);
  const repaired = fs.readFileSync(
    path.join(path.dirname(cached), metadata.releaseId + '.ready'),
    'utf8',
  );
  assert(repaired.startsWith(metadata.releaseId + '.repair-'));
  assert.equal(fs.readFileSync(path.join(cached, 'RUN.txt'), 'utf8'), 'incomplete cache fixture');
  assert.equal(
    validatePackage(path.join(path.dirname(cached), repaired)).releaseId,
    metadata.releaseId,
  );
  await invoke(entry, installed);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(cached), metadata.releaseId + '.ready'), 'utf8'),
    repaired,
  );
  assert.equal(
    fs
      .readdirSync(path.dirname(cached), { withFileTypes: true })
      .filter((item) => item.isDirectory()).length,
    2,
  );
  assert.equal(readJson(path.join(first.data, 'instance.lock')).pid, pid);
  checks.push(
    'Damaged program cache is retained and rebuilt from the embedded package without replacing user data or restarting the running instance',
  );
  if (args[5]) {
    const previous = validatePackage(path.resolve(args[5])),
      directory = path.join(root, '旧版 升级安装');
    const probe = createServer();
    await new Promise((done) => probe.listen(0, '127.0.0.1', done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const config = path.join(root, 'previous-config.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        port,
        dataDir: path.join(root, 'previous-data'),
        logLevel: 'warn',
      }),
    );
    installations.add(directory);
    const clean = { ...environment };
    delete clean.NODE_OPTIONS;
    await run(
      path.join(previous.root, 'runtime/node.exe'),
      [
        path.join(previous.root, 'launcher/control-plane.mjs'),
        'open-package',
        '--release',
        previous.root,
        '--directory',
        directory,
        '--config',
        config,
        '--headless',
      ],
      { env: clean, windowsHide: true, timeout: 180000 },
    );
    const before = settings(directory);
    await json(before.base, '/api/projects', { id: 'upgrade-proof', name: '旧版保留项目' });
    await invoke(entry, directory);
    const after = settings(directory);
    assert.equal(after.state.id, before.state.id);
    assert.equal(after.state.current.releaseId, metadata.releaseId);
    assert.equal((await json(after.base, '/health')).deployment.releaseId, metadata.releaseId);
    assert(
      (await json(after.base, '/api/control-center')).projects.some(
        (project) => project.id === 'upgrade-proof',
      ),
    );
    assert(fs.existsSync(before.state.current.releaseDir));
    assert(fs.readdirSync(path.join(directory, 'backups')).length > 0);
    checks.push(
      'Opening the new EXE upgrades an actual prior release, verifies retained projects and keeps the old version and backup',
    );
  }
} catch (error) {
  failure = error;
} finally {
  for (const directory of installations) {
    if (!fs.existsSync(path.join(directory, 'installation.json'))) continue;
    try {
      const entry = path.join(directory, '工作台.exe');
      if (fs.existsSync(entry)) await invoke(entry, directory, ['--stop']);
      else {
        const clean = { ...environment };
        delete clean.NODE_OPTIONS;
        await run(
          path.join(directory, 'runtime/node.exe'),
          [path.join(directory, 'launcher/control-plane.mjs'), 'stop'],
          { env: clean, windowsHide: true, timeout: 45000 },
        );
      }
      assert(!fs.existsSync(path.join(settings(directory).data, 'instance.lock')));
    } catch (error) {
      failure ??= error;
    }
  }
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  fs.writeFileSync(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        status: failure ? 'failed' : 'passed',
        releaseId: metadata.releaseId,
        checks,
        systemNodeAvailable: false,
        modelPrompts: 0,
        dailyInstallationChanged: false,
        error: failure?.stack,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, evidence: root }));
