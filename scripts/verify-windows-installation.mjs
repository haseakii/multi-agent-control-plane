import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { copyReleaseDirectory, readJson, validatePackage } from './lib/installation.mjs';

const args = process.argv.slice(2);
if (
  process.platform !== 'win32' ||
  args.length !== 4 ||
  args[0] !== '--directory' ||
  args[2] !== '--evidence'
)
  throw Error(
    'Usage: node scripts/verify-windows-installation.mjs --directory PACKAGE --evidence NEW_DIRECTORY (Windows only)',
  );
const original = validatePackage(path.resolve(args[1]));
const evidence = path.resolve(args[3]);
if (fs.existsSync(evidence)) throw Error('First-install evidence directory must be new.');
fs.mkdirSync(evidence, { recursive: true });
const source = path.join(evidence, '解压 含空格路径', 'release');
const installation = path.join(evidence, '新机器 用户空间', 'workbench');
const configFile = path.join(evidence, 'isolated-config.json');
const dataDir = path.join(evidence, 'private-data');
const probe = createServer();
await new Promise((ok, no) => {
  probe.once('error', no);
  probe.listen(0, '127.0.0.1', ok);
});
const port = probe.address().port;
await new Promise((ok, no) => probe.close((error) => (error ? no(error) : ok())));
fs.writeFileSync(configFile, JSON.stringify({ version: 1, port, dataDir, logLevel: 'warn' }));
const checks = [];
let failure;
try {
  copyReleaseDirectory(original.root, source);
  assert.equal(validatePackage(source).releaseId, original.releaseId);
  const npmVersion = readJson(path.join(source, 'runtime/npm/package.json')).version;
  for (const tool of ['npm', 'npx']) {
    const child = spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', `call "${path.join(source, 'runtime', tool + '.cmd')}" --version`],
      {
        windowsHide: true,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, NPM_CONFIG_PREFIX: path.join(evidence, 'old broken nvm prefix') },
      },
    );
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.equal(child.stdout.trim(), npmVersion);
  }
  checks.push(
    'Private npm/npx CMD entrypoints use the matched bundled runtime despite an unrelated global prefix',
  );
  const runtimeFile = path.join(source, 'runtime/node.exe');
  const main = path.join(source, 'apps/server/dist/release-main.js');
  const environment = { ...process.env };
  delete environment.CONTROL_PLANE_DEPLOYMENT_CONTEXT;
  const log = fs.openSync(path.join(evidence, 'foreground.log'), 'a');
  const foreground = spawn(runtimeFile, [main, '--config', configFile], {
    windowsHide: true,
    env: environment,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let spawnError;
  const exited = new Promise((done) => {
    foreground.once('error', (error) => {
      spawnError = error;
      done(null);
    });
    foreground.once('exit', done);
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (foreground.exitCode !== null) throw Error('Foreground package exited before readiness.');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        ready = response.ok && (await response.json()).status === 'ok';
      } catch {
        /* The isolated process may still be opening its database. */
      }
      if (ready) break;
      await delay(100);
    }
    assert(ready, 'Foreground package did not become ready.');
    for (const route of [
      '/api/external-clients',
      '/api/agent-installations',
      '/api/agent-catalog',
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, route);
      if (route.endsWith('agent-catalog'))
        assert.equal((await response.json()).installationSupported, true);
    }
    checks.push(
      'Actual foreground package exposes MCP clients, projects and ACP download management without deployment context',
    );
  } finally {
    const stop = spawnSync(runtimeFile, [main, 'stop', '--config', configFile], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 45000,
      env: environment,
    });
    if (stop.status !== 0) foreground.kill(); // Only the child created above, with empty isolated data.
    assert.equal(await exited, 0, 'Foreground verification process did not stop normally.');
    assert.equal(stop.status, 0, stop.stderr);
    assert(!fs.existsSync(path.join(dataDir, 'instance.lock')));
  }
  const command = `call "${path.join(source, '打开工作台.cmd')}" --directory "${installation}" --config "${configFile}" --headless`;
  let identity;
  for (const phase of ['first-open', 'repeat-open']) {
    const child = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, CONTROL_PLANE_NO_PAUSE: '1' },
    });
    fs.writeFileSync(
      path.join(evidence, phase + '.log'),
      (child.stdout ?? '') + (child.stderr ?? ''),
    );
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    const current = readJson(path.join(installation, 'installation.json'));
    if (identity) assert.equal(current.id, identity);
    identity = current.id;
    assert.equal(current.current.releaseId, original.releaseId);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) =>
      response.json(),
    );
    assert.equal(health.status, 'ok');
    assert.equal(health.deployment.installationId, identity);
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/control-center`).then((response) =>
      response.json(),
    );
    assert.equal(snapshot.agents.length, 0);
    assert.equal(snapshot.tasks.length, 0);
    assert.equal(snapshot.executionAttempts.length, 0);
    checks.push(
      `${phase}: actual CMD, Unicode paths, private installation and empty database passed`,
    );
  }
  assert.equal(validatePackage(source).releaseId, original.releaseId);
  assert.equal(
    validatePackage(path.join(installation, 'versions', original.releaseId)).releaseId,
    original.releaseId,
  );
  checks.push('Source and installed versions retain exact verified file inventories');
} catch (error) {
  failure = error;
} finally {
  if (fs.existsSync(path.join(installation, 'installation.json'))) {
    const stop = spawnSync(
      path.join(installation, 'runtime/node.exe'),
      [path.join(installation, 'launcher/control-plane.mjs'), 'stop'],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 45000,
      },
    );
    fs.writeFileSync(path.join(evidence, 'stop.log'), (stop.stdout ?? '') + (stop.stderr ?? ''));
    if (stop.status !== 0)
      failure ??= Error(
        'First-install test instance could not stop: ' + (stop.error?.message ?? stop.stderr),
      );
    else if (fs.existsSync(path.join(dataDir, 'instance.lock')))
      failure ??= Error('Instance lock was not released.');
    else checks.push('Product stop completed and released the isolated instance lock');
  }
  fs.writeFileSync(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        status: failure ? 'failed' : 'passed',
        sourceReleaseId: original.releaseId,
        checks,
        realModelCalls: 0,
        dailyInstallationChanged: false,
        error: failure?.message,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log('Windows first-install verification passed.');
