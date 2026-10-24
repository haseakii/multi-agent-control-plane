import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request } from 'node:http';
const args = process.argv.slice(2);
if (
  args.length !== 6 ||
  args[0] !== '--directory' ||
  args[2] !== '--url' ||
  args[4] !== '--evidence'
)
  throw Error(
    'Usage: --directory ISOLATED_TEST_PACKAGE --url LOCAL_URL --evidence OUTPUT_DIRECTORY. The verifier starts its own isolated process with explicit conflicting developer environment variables.',
  );
const pack = resolve(args[1]),
  base = args[3],
  output = resolve(args[5]);
const parsed = new URL(base);
assert.equal(parsed.hostname, '127.0.0.1');
assert.equal(parsed.protocol, 'http:');
const bundled = join(pack, 'runtime/node.exe'),
  entry = join(pack, 'apps/server/dist/release-main.js');
const sourceConfig = JSON.parse(readFileSync(join(pack, 'config.json'), 'utf8'));
mkdirSync(output, { recursive: true });
if (existsSync(join(output, 'release-smoke.json')) || existsSync(join(output, '验收 数据')))
  throw Error('Evidence/test-data directory must be fresh; old results are never overwritten.');
const config = { ...sourceConfig, port: Number(parsed.port), dataDir: join(output, '验收 数据') };
const configPath = join(output, 'isolated-config.json');
writeFileSync(configPath, JSON.stringify(config));
const legacyDb = join(output, 'must-not-created.sqlite');
const conflictEnv = {
  SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
  PATH: dirname(bundled),
  TEMP: tmpdir(),
  TMP: tmpdir(),
  HOST: '0.0.0.0',
  PORT: String(config.port + 1),
  CONTROL_PLANE_DB: legacyDb,
  CONTROL_PLANE_DEMO: '1',
};
let stdout = '',
  stderr = '',
  spawnError;
const instance = spawn(bundled, [entry, '--config', configPath], {
  cwd: tmpdir(),
  env: conflictEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
instance.stdout.on('data', (chunk) => (stdout += chunk));
instance.stderr.on('data', (chunk) => (stderr += chunk));
instance.once('error', (error) => {
  spawnError = error;
});
let failure;

const checks = [];
const record = (name, details) => checks.push({ name, details });
function raw(path, headers = {}, method = 'GET', body) {
  return new Promise((ok, no) => {
    const req = request(
      { hostname: parsed.hostname, port: parsed.port, path, method, headers },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.once('error', no);
    req.end(body);
  });
}
try {
  const deadline = Date.now() + 15000;
  while (!stdout.includes('Control Plane ready:')) {
    if (spawnError || instance.exitCode !== null || Date.now() > deadline)
      throw Error('Isolated startup failed: ' + (spawnError?.message ?? stderr));
    await delay(100);
  }
  assert(stdout.includes(`Control Plane ready: http://127.0.0.1:${config.port}`));
  assert(stdout.includes(`Data: ${config.dataDir}`));
  assert(existsSync(join(config.dataDir, 'control-plane.sqlite')));
  const powershell = join(conflictEnv.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  assert(Number.isInteger(instance.pid));
  const sockets = [].concat(
    JSON.parse(
      execFileSync(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-NetTCPConnection -OwningProcess ${instance.pid} -State Listen -ErrorAction Stop | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8' },
      ).trim(),
    ),
  );
  assert(sockets.length > 0);
  for (const socket of sockets) {
    assert.equal(socket.LocalAddress, '127.0.0.1');
    assert.equal(socket.LocalPort, config.port);
  }
  record('explicit-conflicting-environment-isolation', {
    HOST: conflictEnv.HOST,
    PORT: conflictEnv.PORT,
    CONTROL_PLANE_DB: legacyDb,
    CONTROL_PLANE_DEMO: '1',
    sockets,
    dataDir: config.dataDir,
  });
  const releaseManifest = JSON.parse(readFileSync(join(pack, 'release-manifest.json'), 'utf8'));
  assert.equal(releaseManifest.node, 'v22.22.2');
  assert.equal(releaseManifest.nodeSignature.status, 'Valid');
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(hash(bundled), releaseManifest.nodeSha256);
  assert(readFileSync(join(pack, 'LICENSE'), 'utf8').includes('Apache License'));
  for (const dependency of releaseManifest.frontend.dependencies) {
    const full = readFileSync(join(pack, 'apps/web/dist', dependency.file), 'utf8');
    assert.equal(createHash('sha256').update(full).digest('hex'), dependency.sha256);
    assert(readFileSync(join(pack, 'THIRD-PARTY-NOTICES.txt'), 'utf8').includes(full));
  }
  for (const name of ['react', 'react-dom', 'scheduler'])
    assert(releaseManifest.frontend.dependencies.some((item) => item.name === name));
  record('repository-frontend-and-node-license-gates', {
    frontend: releaseManifest.frontend.dependencies.map(({ name, version }) => ({ name, version })),
    signature: releaseManifest.nodeSignature.status,
  });
  const empty = await fetch(base + '/api/control-center').then((r) => r.json());
  assert.equal(empty.agents.length, 0);
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.tasks.length, 0);
  assert.equal(empty.executionAttempts.length, 0);
  record('clean-start-no-agent-registration-or-execution', true);
  const html = await raw('/');
  assert.equal(html.status, 200);
  assert.match(html.headers['content-type'], /text\/html/);
  const asset = html.text.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  const js = await raw(asset);
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert(!js.text.startsWith('<!doctype'));
  for (const path of ['/api/not-found', '/internal/not-found', '/config.json', '/runtime/LICENSE'])
    assert.equal((await raw(path)).status, 404);
  const rawPaths = [
    '/assets/../../config.json',
    '/assets/%2e%2e/%2e%2e/config.json',
    '/assets/%2e%2e%2f%2e%2e%2fconfig.json',
    '/assets/..%2f..%2fconfig.json',
    '/assets/%2e%2e%5c%2e%2e%5cconfig.json',
    '/assets/..' + String.fromCharCode(92) + '..' + String.fromCharCode(92) + 'config.json',
    '/assets/%252e%252e%252f%252e%252e%252fconfig.json',
    '/assets/%252e%252e%255c%252e%252e%255cconfig.json',
    '/assets/%2f..%2f..%2fconfig.json',
    '/assets/%5c..%5c..%5cconfig.json',
    '/assets/%00index.js',
  ];
  const probes = [];
  for (const path of rawPaths) {
    const response = await raw(path);
    assert([400, 404].includes(response.status), path + ' returned ' + response.status);
    probes.push({ path, status: response.status });
  }
  record('raw-http-path-traversal-probes', probes);
  for (const headers of [
    { host: 'attacker.example' },
    { origin: 'http://attacker.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://127.0.0.1:1' },
  ])
    for (const path of ['/', '/api/control-center'])
      assert.equal((await raw(path, headers)).status, 403);
  const badPost = await raw(
    '/api/projects',
    { origin: 'http://attacker.example', 'content-type': 'application/json' },
    'POST',
    JSON.stringify({ name: 'must-not-create' }),
  );
  assert.equal(badPost.status, 403);
  record('static-and-api-origin-host-boundaries', true);
  assert(!existsSync(legacyDb));
  record('legacy-demo-and-db-env-ignored', true);
  for (const [name, data, pattern] of [
    ['bad-config.json', { ...config, port: '43931' }, /startup failed/],
    ['same-port.json', config, /EADDRINUSE|address already in use/],
    ['same-data.json', { ...config, port: config.port + 2 }, /Data directory is locked/],
  ]) {
    const file = join(output, name);
    writeFileSync(file, JSON.stringify(data));
    const child = spawnSync(bundled, [entry, '--config', file], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stdout + child.stderr, pattern);
    record(name, { exit: child.status, expectedFailure: true });
  }
  // Load and run Fleet from the moved package; HTTP endpoint is a mock, never a real Agent.
  const packedRequire = createRequire(join(pack, 'package.json'));
  const { getFleetMcpStdioProxyPath } = await import(
    pathToFileURL(join(pack, 'node_modules/@control-plane/fleet-mcp/dist/index.js')).href
  );
  const { Client } = await import(
    pathToFileURL(packedRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(packedRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const manifest = {
    identity: {
      agentId: 'fixture-agent',
      projectId: 'fixture-project',
      sessionId: 'fixture-session',
    },
    agent: {
      id: 'fixture-agent',
      name: 'Fixture only',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'never-executed', args: [] },
      capabilities: [],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    },
  };
  let calls = 0;
  const fake = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/fleet/manifest') {
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.url === '/internal/fleet/tool') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      assert.equal(body.toolName, 'control_get_task');
      calls++;
      res.end(JSON.stringify({ ok: true, result: { id: 'fixture-task' } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'release-fixture', version: '1.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: bundled,
        args: [getFleetMcpStdioProxyPath()],
        cwd: tmpdir(),
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
          PATH: join(pack, 'runtime'),
          TEMP: tmpdir(),
          CONTROL_PLANE_BRIDGE_URL: 'http://127.0.0.1:' + fake.address().port,
          CONTROL_PLANE_BRIDGE_GRANT: 'ephemeral-fixture-only',
        },
      }),
    );
    const tools = await client.listTools();
    assert(tools.tools.some((t) => t.name === 'control_get_task'));
    const result = await client.callTool({
      name: 'control_get_task',
      arguments: { taskId: 'fixture-task' },
    });
    assert(!result.isError, JSON.stringify(result));
    assert.equal(calls, 1);
    record('moved-fleet-stdio-proxy-real-child-with-fake-http', true);
  } finally {
    await client.close();
    await new Promise((r) => fake.close(r));
  }
  const devRequire = createRequire(new URL('../package.json', import.meta.url));
  const { chromium, expect } = devRequire('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [],
    urls = new Set();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => urls.add(r.url()));
  try {
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Multi-Agent Control Plane' })).toBeVisible();
    await expect(page.getByText('No active project', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(output, 'release-empty.png') });
    await page.getByLabel('Project name', { exact: true }).fill('M1 隔离验证项目');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByLabel('Active project')).not.toHaveValue('');
    await page.reload();
    await expect(page.getByLabel('Active project').locator('option')).toContainText([
      'No projects yet',
      'M1 隔离验证项目',
    ]);
    await page.screenshot({ path: join(output, 'release-project.png') });
    assert.deepEqual(errors, []);
    assert([...urls].every((url) => new URL(url).origin === new URL(base).origin));
    record('real-production-ui-create-refresh-single-origin', { requests: urls.size, errors });
  } finally {
    await browser.close();
  }
  const after = await fetch(base + '/api/control-center').then((r) => r.json());
  assert.equal(after.projects.length, 1);
  assert.equal(after.agents.length, 0);
  assert.equal(after.tasks.length, 0);
  record('no-model-or-acp-work-started', true);
  const symlinks = [];
  function scan(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) symlinks.push(path);
      else if (stat.isDirectory()) scan(path);
    }
  }
  scan(join(pack, 'node_modules'));
  assert.deepEqual(symlinks, []);
  record('portable-dependencies-no-pnpm-links', true);
} catch (error) {
  failure = error;
} finally {
  if (instance.exitCode === null && instance.signalCode === null) {
    instance.kill();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Verifier-owned process did not exit')), 10000);
      timer.unref();
      instance.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const lock = join(config.dataDir, 'instance.lock');
  record('verifier-owned-process-cleanup', {
    pid: instance.pid,
    exited: instance.exitCode !== null || instance.signalCode !== null,
    method: 'Known spawned child only; Windows termination, not product graceful stop',
    staleLockRetained: existsSync(lock),
  });
  writeFileSync(join(output, 'startup.stdout.log'), stdout);
  writeFileSync(join(output, 'startup.stderr.log'), stderr);
}
writeFileSync(
  join(output, 'release-smoke.json'),
  JSON.stringify(
    {
      machine: process.env.COMPUTERNAME,
      pack,
      base,
      checks,
      realModelCalls: 0,
      formalDatabaseChanged: false,
      result: failure ? 'failed' : 'passed',
      error: failure?.message,
    },
    null,
    2,
  ),
);
if (failure) throw failure;
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
