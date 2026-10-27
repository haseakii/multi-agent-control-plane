import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openSqliteStorage } from '../packages/storage/dist/index.js';
import { AgentControlService } from '../apps/server/dist/agent-control.js';
import { buildServer } from '../apps/server/dist/server.js';
import { createControlPlaneRuntime } from '../apps/server/dist/runtime-composition.js';
import { readControlCenterSnapshot } from '../apps/server/dist/control-center.js';
import { AgentCatalogService } from '../apps/server/dist/agent-catalog.js';
import { createLocalIntegrations } from '../apps/server/dist/local-integrations.js';

const [web, evidence] = process.argv.slice(2);
assert(web && evidence, 'Usage: node scripts/verify-member-actions.mjs WEB_ROOT NEW_EVIDENCE');
const root = path.resolve(evidence);
assert(!fs.existsSync(root), 'Preserve earlier evidence.');
fs.mkdirSync(root, { recursive: true });
const storage = openSqliteStorage({ filename: path.join(root, 'state.sqlite') });
const runtime = createControlPlaneRuntime({
  storage,
  workspaceRoot: path.join(root, 'workspaces'),
  artifactRoot: path.join(root, 'artifacts'),
});
const gates = new Map(),
  calls = [];
function hold(key) {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  gates.set(key, promise);
  return () => {
    gates.delete(key);
    release();
  };
}
async function observe(agent, kind) {
  calls.push(`${agent.id}:${kind}`);
  await gates.get(`${agent.id}:${kind}`);
  return {
    readiness: {
      runtime: 'ready',
      auth: kind === 'auth' ? 'ready' : 'unknown',
      observedAt: new Date().toISOString(),
      authMethodIds: ['login'],
    },
    authMethods: [{ id: 'login', name: 'Fixture login' }],
  };
}
const control = new AgentControlService(storage, {
  probe: (agent) => observe(agent, 'probe'),
  authenticate: (agent) => observe(agent, 'auth'),
});
for (const id of ['A', 'B']) {
  control.create({
    id,
    name: `成员 ${id}`,
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [path.resolve('packages/acp-runtime/fixtures/auth-agent.mjs')],
    },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
  await control.probe(id);
}
const catalog = new AgentCatalogService();
const local = createLocalIntegrations({
  storage,
  runtime,
  catalog,
  dataDir: root,
  releaseRoot: path.resolve('.'),
  baseUrl: 'http://127.0.0.1:0',
});
const app = buildServer({
  ...local,
  webRoot: path.resolve(web),
  agentControl: control,
  taskControl: runtime,
  agentCatalog: catalog,
  controlCenter: (options) =>
    readControlCenterSnapshot(storage, (id) => control.state(id), undefined, undefined, options),
});
app.get('/api/workbench', async () => ({ mode: 'mock', profile: 'acceptance', promptsUsed: 0 }));
let browser, page, failure;
const errors = [];
const releaseAuth = hold('A:auth'),
  releaseProbe = hold('B:probe');
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  local.setBaseUrl(base);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: '协作成员', exact: true }).click();
  const a = page.getByRole('region', { name: '成员 A 连接状态', exact: true });
  const b = page.getByRole('region', { name: '成员 B 连接状态', exact: true });
  await a.getByRole('button', { name: '登录 / 确认登录', exact: true }).click();
  await expect.poll(() => control.state('A').connectionOperation).toBe('auth');
  await expect(a.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
  await expect(b.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
  await b.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect.poll(() => control.state('B').connectionOperation).toBe('probe');
  await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭协作者连接', exact: true }).click();
  await page.getByRole('button', { name: '协作成员', exact: true }).click();
  await expect(a.getByRole('button', { name: '等待登录完成…', exact: true })).toBeDisabled();
  await expect(b.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(root, 'independent-pending.png') });
  releaseProbe();
  await expect(b.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
  await expect(a.getByRole('button', { name: '等待登录完成…', exact: true })).toBeDisabled();
  releaseAuth();
  await expect(a.getByText('已登录', { exact: true })).toBeVisible();
  await expect(a.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
  assert.equal(calls.filter((call) => call === 'A:auth').length, 1);
  assert.equal(calls.filter((call) => call === 'B:probe').length, 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'completed.png') });
  fs.writeFileSync(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        checks: [
          'independent member actions',
          'same-member duplicate guard',
          'close and reopen pending operations',
          'poll completion without a global lock',
          'no stale navigation after unmount',
        ],
        calls,
        browserErrors: errors,
        modelPrompts: 0,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: 5, modelPrompts: 0, evidence: root }));
} catch (error) {
  failure = error;
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  releaseAuth();
  releaseProbe();
  await browser?.close();
  await app.close();
  await runtime.close();
  storage.close();
}
if (failure) throw failure;
