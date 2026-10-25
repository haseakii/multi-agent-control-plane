import { catalogFixture, openCatalog } from './helpers';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';

const fixture = resolve('packages/acp-runtime/fixtures/negotiation-agent.mjs');
const evidence = process.env.CONTROL_PLANE_A0_EVIDENCE;
test.beforeEach(async ({ page }) => {
  await page.route('**/api/agent-catalog', (route) => route.fulfill({ json: catalogFixture }));
  // These cases specifically verify polling fallback preserves input/focus.
  await page.route('**/api/projects/*/events/stream', (route) => route.abort());
});
for (const width of [1366, 1024]) {
  test(`A0 real binding and initialize observation at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await openCatalog(page);
    const catalog = page.getByRole('region', { name: 'ACP 接入目录' });
    await expect(catalog.getByText('本机固定测试入口 A', { exact: true })).toBeVisible();
    expect(await catalog.locator('img').count()).toBe(0);
    expect(await catalog.locator('script').count()).toBe(0);
    await expect(catalog.getByRole('button', { name: '安装 / 更新（A0 未实现）' })).toBeDisabled();
    const card = catalog.locator('.catalog-card').filter({ hasText: '本机固定测试入口 A' });
    await card.getByRole('button', { name: '绑定已有本地入口' }).click();
    await page.locator('.registration-advanced > summary').click();
    const id = `a0-${width}-${Date.now()}`;
    await page.getByLabel('内部标识（自动生成）', { exact: true }).fill(id);
    await page.getByLabel('启动程序路径', { exact: true }).fill(process.execPath);
    await page.getByLabel('启动参数（需要时填写，每行一个）').fill(fixture);
    // Catalog commands/args/env were never inserted into the editable runtime.
    await expect(page.getByLabel('继承的环境变量名')).toHaveValue('');
    await page.getByRole('button', { name: '添加成员', exact: true }).click();
    const agent = page.locator('.agent-card').filter({ hasText: id });
    await expect(agent).toContainText('未启用');
    await expect(agent).toContainText('文件校验通过');
    await expect(agent).toContainText('未探针');
    await agent.getByRole('button', { name: '检查连接', exact: true }).click();
    await expect(agent).toContainText('可连接（initialize）');
    await expect(agent).toContainText('未知；探针不代表已登录');
    await agent.getByText('入口、协商与权限详情', { exact: true }).click();
    await expect(agent).toContainText('negotiation-only-fixture');
    await expect(agent).toContainText('fixture-login');
    await expect(agent).toContainText('配置的 Fleet MCP：mcp；scopes：');
    await expect(agent).not.toContainText('synthetic-extension-not-public');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (evidence)
      await page.screenshot({ path: join(evidence, `real-probe-${width}.png`), fullPage: true });
    await agent.getByRole('button', { name: '启用入口', exact: true }).click();
    await expect(agent).toContainText('已启用（不会自动提交任务）');
    const before = (await (await page.request.get('/api/control-center')).json()).executionAttempts
      .length;
    await page.reload();
    await openCatalog(page);
    const after = page.locator('.agent-card').filter({ hasText: id });
    await expect(after).toContainText('未探针'); // Explicit enable changes invalidate the prior observation.
    expect(
      (await (await page.request.get('/api/control-center')).json()).executionAttempts.length,
    ).toBe(before);
  });
  test(`A0 directory text, draft, keyboard and polling stability at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await openCatalog(page);
    const catalog = page.getByRole('region', { name: 'ACP 接入目录' });
    await expect(catalog.locator('.catalog-card')).toHaveCount(2);
    await expect(catalog).toContainText('<img src=x onerror=alert(1)>');
    expect(await catalog.locator('img').count()).toBe(0);
    expect(await catalog.locator('a[href^="javascript:"]').count()).toBe(0);
    await page.getByRole('button', { name: '＋ 添加成员', exact: true }).click();
    await page.locator('.registration-advanced > summary').click();
    await page.getByLabel('内部标识（自动生成）', { exact: true }).fill('my-custom-draft');
    await page.getByLabel('启动程序路径', { exact: true }).fill('D:\\explicit\\chosen.exe');
    await page.getByLabel('启动参数（需要时填写，每行一个）').fill('--user-argument');
    await catalog
      .locator('.catalog-card')
      .filter({ hasText: '本机固定测试入口 A' })
      .getByRole('button', { name: '绑定已有本地入口' })
      .click();
    await expect(page.getByLabel('内部标识（自动生成）', { exact: true })).toHaveValue(
      'my-custom-draft',
    );
    await expect(page.getByLabel('启动程序路径', { exact: true })).toHaveValue(
      'D:\\explicit\\chosen.exe',
    );
    await expect(page.getByLabel('启动参数（需要时填写，每行一个）')).toHaveValue(
      '--user-argument',
    );
    await page.getByRole('button', { name: '切回自定义入口（保留草稿）' }).click();
    await expect(page.getByLabel('内部标识（自动生成）', { exact: true })).toHaveValue(
      'my-custom-draft',
    );
    await catalog.getByLabel('搜索目录').fill('固定测试入口');
    await catalog.locator('summary').first().focus();
    await page.keyboard.press('Enter');
    await expect(catalog.locator('details').first()).toHaveAttribute('open', '');
    await page.waitForResponse('**/api/control-center');
    await expect(catalog.locator('summary').first()).toBeFocused();
    await expect(catalog.locator('details').first()).toHaveAttribute('open', '');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (evidence)
      await page.screenshot({ path: join(evidence, `catalog-${width}.png`), fullPage: true });
  });
}
test('A0 failed refresh retains cache and duplicate click does not repeat network work', async ({
  page,
}) => {
  let release!: () => void,
    posts = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/agent-catalog/refresh', async (route) => {
    posts++;
    await gate;
    await route.fulfill({ json: { ...catalogFixture, error: '官方目录刷新失败；保留原缓存。' } });
  });
  await page.goto('/');
  await openCatalog(page);
  const catalog = page.getByRole('region', { name: 'ACP 接入目录' });
  await expect(catalog.locator('.catalog-card')).toHaveCount(2);
  const refresh = catalog.getByRole('button', { name: '刷新官方目录', exact: true });
  await refresh.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(catalog.getByRole('button', { name: '正在刷新目录…' })).toBeDisabled();
  expect(posts).toBe(1);
  release();
  await expect(catalog.getByRole('alert')).toContainText('保留原缓存');
  await expect(catalog.locator('.catalog-card')).toHaveCount(2);
});
test('A0 absent/offline catalog leaves custom registration reachable', async ({ page }) => {
  await page.route('**/api/agent-catalog', (route) =>
    route.fulfill({
      json: {
        source: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
        fetchedAt: null,
        stale: false,
        storage: 'empty',
        platform: 'windows-x86_64',
        entries: [],
        error: '本机目录缓存无效；可手动刷新。',
      },
    }),
  );
  await page.goto('/');
  await openCatalog(page);
  await expect(page.getByRole('region', { name: 'ACP 接入目录' }).getByRole('alert')).toContainText(
    '缓存无效',
  );
  await page.getByRole('button', { name: '＋ 添加成员', exact: true }).click();
  await page.locator('.registration-advanced > summary').click();
  await expect(page.getByRole('heading', { name: '添加已有的 AI 成员' })).toBeVisible();
  await page.getByLabel('内部标识（自动生成）', { exact: true }).fill('offline-custom');
  await page.waitForResponse('**/api/control-center');
  await expect(page.getByLabel('内部标识（自动生成）', { exact: true })).toHaveValue(
    'offline-custom',
  );
});
