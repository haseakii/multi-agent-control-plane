import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { TaskSchema } from '../packages/core/dist/index.js';
import { openSqliteStorage } from '../packages/storage/dist/index.js';
import { buildServer } from '../apps/server/dist/server.js';
import { createControlPlaneRuntime } from '../apps/server/dist/runtime-composition.js';
import { readControlCenterSnapshot } from '../apps/server/dist/control-center.js';
import { AgentCatalogService } from '../apps/server/dist/agent-catalog.js';
import { AgentInstallationsService } from '../apps/server/dist/agent-installations.js';
import { createLocalIntegrations } from '../apps/server/dist/local-integrations.js';

const args = process.argv.slice(2);
assert(
  args.length === 4 && args[0] === '--web-root' && args[2] === '--evidence',
  'Usage: node scripts/verify-hermes-usability.mjs --web-root BUILT_HERMES --evidence NEW_DIRECTORY',
);
const webRoot = path.resolve(args[1]),
  root = path.resolve(args[3]);
assert(!fs.existsSync(root), 'Keep previous verification evidence; choose a new directory.');
fs.mkdirSync(root, { recursive: true });
const storage = openSqliteStorage({ filename: path.join(root, 'state.sqlite') });
const runtime = createControlPlaneRuntime({
  storage,
  workspaceRoot: path.join(root, 'workspaces'),
  artifactRoot: path.join(root, 'artifacts'),
});
const fixtureRuntime = {
  type: 'acp-stdio',
  command: process.execPath,
  args: [path.resolve('packages/acp-runtime/fixtures/auth-agent.mjs')],
};
const entry = {
  id: 'fixture',
  name: '回归 ACP',
  version: '1.0.0',
  description: 'Only a local test fixture',
  license_url: 'https://example.com/LICENSE',
  distribution: {
    binary: {
      'windows-x86_64': { archive: 'https://example.com/fixture.zip', cmd: './fixture.exe' },
    },
  },
};
const catalog = new AgentCatalogService(
  undefined,
  async () =>
    new Response(JSON.stringify({ version: '1.0.0', agents: [entry] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
);
await catalog.refresh();
const local = createLocalIntegrations({
  storage,
  runtime,
  catalog,
  dataDir: root,
  releaseRoot: path.resolve('.'),
  baseUrl: 'http://127.0.0.1:0',
});
let installs = 0;
let finishInstall, installUpdates;
const installGate = new Promise((resolve) => {
  finishInstall = resolve;
});
const agentInstallations = new AgentInstallationsService({
  storage,
  catalog,
  agents: runtime.agentControl,
  network: runtime.network,
  root: path.join(root, 'agents'),
  releaseRoot: path.resolve('.'),
  installPackage: async ({ phase, progress }) => {
    installs++;
    installUpdates = { phase, progress };
    phase('downloading', '正在下载回归程序');
    progress({ receivedBytes: 52428800, totalBytes: 104857600 });
    await installGate;
    phase('installing', '测试安装完成，未访问外网');
    return fixtureRuntime;
  },
});
runtime.createProject({ id: 'p', name: '界面回归项目' });
runtime.setWorkspaceMode('p', { mode: 'task-local' });
runtime.agentControl.create({
  id: 'fixture',
  name: '回归成员',
  enabled: true,
  runtime: fixtureRuntime,
  capabilities: [],
  auth: { mode: 'agent-managed' },
  orchestration: { canBeBoss: false },
  controlBridge: { transport: 'none', scopes: [] },
});
const task = TaskSchema.parse({
  id: 'task',
  projectId: 'p',
  title: '阅读与设置回归',
  objective: '核对对话阅读区域、设置和草稿。',
  state: 'completed',
  ownerAgentId: 'fixture',
  dependencyIds: [],
  contextRefs: [],
  resultArtifactRefs: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
storage.repositories.tasks.upsert(task);
const result = await runtime.artifacts.publish({
  projectId: 'p',
  taskId: 'task',
  producerAgentId: 'fixture',
  kind: 'report',
  mimeType: 'text/plain',
  content: new TextEncoder().encode(
    '这是本地测试回复，用于核对文字、滚动与阅读空间。\n'.repeat(35),
  ),
  links: [{ entityType: 'task', entityId: 'task' }],
});
storage.repositories.tasks.upsert({ ...task, resultArtifactRefs: [result.artifact.id] });
const app = buildServer({
  ...local,
  agentInstallations,
  webRoot,
  agentControl: runtime.agentControl,
  agentCatalog: catalog,
  taskControl: runtime,
  clientGateway: { storage, runtime, readAccess: local.externalClients.readAccess },
  controlCenter: (options) =>
    readControlCenterSnapshot(
      storage,
      (id) => runtime.agentControl.state(id),
      undefined,
      undefined,
      options,
    ),
});
app.get('/api/workbench', async () => ({ mode: 'mock', profile: 'acceptance', promptsUsed: 0 }));
let browser, page, failure;
const checks = [],
  browserErrors = [];
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  local.setBaseUrl(base);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1912, height: 914 } });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(base + '/?task=task');
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  const composer = page.locator('textarea').first();
  await composer.fill('放大后仍保留的草稿');
  const normalHeight = (
    await page.getByRole('region', { name: '会话消息', exact: true }).boundingBox()
  ).height;
  assert(normalHeight >= 280, 'The normal conversation must have usable vertical space.');
  const reading = page.getByRole('button', { name: '放大对话', exact: true });
  await reading.click();
  const readingHeight = (
    await page.getByRole('region', { name: '会话消息', exact: true }).boundingBox()
  ).height;
  assert(
    readingHeight >= normalHeight + 180,
    'Reading mode must materially expand the conversation.',
  );
  await page.screenshot({ path: path.join(root, 'reading.png') });
  await expect(composer).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('放大后仍保留的草稿');
  checks.push('Reading view expands the conversation and preserves the unsent draft on Escape');
  await page.getByRole('button', { name: '运行设置', exact: true }).click();
  await page.getByRole('button', { name: '读取可用设置', exact: true }).click();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('small', { timeout: 15000 });
  await page.getByLabel('模型', { exact: true }).selectOption('large');
  await expect(page.getByRole('button', { name: '用于下次发送', exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await page.getByRole('button', { name: '用于下次发送', exact: true }).click();
  checks.push(
    'Prompt-free ACP inspection reads actual fixture models, validates a change and applies it to the next-send draft',
  );
  runtime.sessionSettings.prepare('task', 'fixture');
  const inspected = await runtime.sessionSettings.inspect('fixture', 'p');
  runtime.sessionSettings.repository.putTask({
    ...runtime.sessionSettings.repository.getTask('task'),
    state: 'applied',
    confirmed: inspected.settings,
  });
  storage.repositories.tasks.upsert({
    ...storage.repositories.tasks.get('task'),
    state: 'running',
  });
  await page.reload();
  await page.getByRole('button', { name: /查看运行设置/ }).click();
  await expect(page.getByRole('region', { name: '本轮实际生效设置' })).toContainText('Small');
  await expect(page.getByRole('button', { name: '核对当前参数', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(root, 'settings-running.png') });
  await page.getByRole('button', { name: '关闭运行设置' }).click();
  checks.push(
    'An active task remains inspectable with its confirmed settings and cannot mutate the running selection',
  );
  storage.repositories.tasks.upsert({
    ...storage.repositories.tasks.get('task'),
    state: 'completed',
  });
  await page.getByRole('button', { name: '接入应用 · MCP', exact: true }).click();
  await expect(page.getByText('MCP 接入点在哪里？', { exact: true })).toBeVisible();
  await page.getByLabel('使用的应用').selectOption('generic');
  await page.getByRole('button', { name: '授权并生成接入', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '完整 MCP 配置' })).toBeVisible();
  const config = JSON.parse(
    await page.getByRole('textbox', { name: '完整 MCP 配置' }).inputValue(),
  );
  assert(Object.values(config.mcpServers)[0].args.includes('--connection'));
  await page.screenshot({ path: path.join(root, 'mcp.png') });
  await page.getByRole('button', { name: '关闭应用接入' }).click();
  checks.push(
    'Foreground startup exposes projects and generates visible local stdio MCP configuration without Not Found',
  );
  await page.getByRole('button', { name: '协作成员', exact: true }).click();
  await page.getByRole('button', { name: /添加 \/ 下载 ACP/ }).click();
  assert.equal(installs, 0);
  const changedPlan = async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, version: '1.0.1' } });
  };
  await page.route('**/api/agent-catalog/fixture/install-plan', changedPlan);
  await page
    .getByRole('group', { name: '回归 ACP', exact: true })
    .getByRole('button', { name: '安装', exact: true })
    .click();
  await expect(
    page.getByText('目录版本已变化，请核对新版本后再点击安装。', { exact: true }),
  ).toBeVisible();
  assert.equal(installs, 0);
  await page.getByRole('button', { name: '返回产品目录', exact: true }).click();
  await page.unroute('**/api/agent-catalog/fixture/install-plan', changedPlan);
  checks.push(
    'A changed plan version never starts an installation under the old one-click request',
  );
  await page
    .getByRole('group', { name: '回归 ACP', exact: true })
    .getByRole('button', { name: '安装', exact: true })
    .click();
  await expect(page.getByText('已下载 50.0 MB / 100.0 MB（50%）', { exact: false })).toBeVisible();
  const installPath = agentInstallations.list()[0].directory;
  await expect(page.getByRole('textbox', { name: '本次安装位置', exact: true })).toHaveValue(
    installPath,
  );
  await expect(page.getByRole('progressbar', { name: '当前步骤进度' })).toHaveAttribute(
    'value',
    '50',
  );
  const locationBox = await page
    .getByRole('textbox', { name: '本次安装位置', exact: true })
    .boundingBox();
  assert(
    locationBox && locationBox.y + locationBox.height < 850,
    'Progress and location should be visible without scrolling',
  );
  await page.screenshot({ path: path.join(root, 'acp-downloading.png') });
  installUpdates.progress({ receivedBytes: 62914560 });
  await expect(page.getByText('已下载 60.0 MB · 总大小未知', { exact: false })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '当前步骤进度' })).not.toHaveAttribute(
    'value',
  );
  installUpdates.phase('installing', '正在安装依赖；此步骤不提供总下载量');
  await expect(
    page.getByText('正在安装依赖；此步骤不提供总下载量', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText(/已下载 60.0 MB/)).toHaveCount(0);
  await page.getByRole('button', { name: '返回产品目录', exact: true }).click();
  await page.getByRole('button', { name: '已下载程序与安装记录', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '本次安装位置', exact: true })).toHaveValue(
    installPath,
  );
  await expect(page.getByRole('progressbar', { name: '当前步骤进度' })).toBeVisible();
  finishInstall();
  checks.push(
    'Live download bytes, unknown totals, phase changes and exact installation paths remain visible after reopening records',
  );
  await expect(page.getByText('已安装', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('本机安装入口', { exact: true })).toBeVisible();
  assert.equal(installs, 1);
  await page.screenshot({ path: path.join(root, 'acp.png') });
  await expect(page.getByRole('button', { name: '登录并使用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '登录并使用', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '协作者连接' })).toBeHidden({ timeout: 15000 });
  const installedMember = agentInstallations.list()[0].members[0];
  assert.equal(installedMember.readiness.auth, 'ready');
  await expect(page.getByRole('region', { name: '下次发送的运行设置' })).toContainText('回归 ACP');
  assert.equal(storage.repositories.tasks.list().length, 1);
  checks.push(
    'One click installs, then in-place Agent login selects the member for an unsent draft; installation records remain available',
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(root, 'compact.png') });
  assert.deepEqual(browserErrors, []);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(storage.repositories.executionAttempts.list().length, 0);
} catch (error) {
  failure = error;
  await page?.screenshot({ path: path.join(root, 'failure.png') });
} finally {
  finishInstall();
  await browser?.close();
  await agentInstallations.settle();
  await app.close();
  await runtime.close();
  storage.close();
  fs.writeFileSync(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        checks,
        modelPrompts: 0,
        externalDownloads: 0,
        installs,
        browserErrors,
        error: failure?.stack,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(
  JSON.stringify({ checks: checks.length, modelPrompts: 0, externalDownloads: 0, evidence: root }),
);
