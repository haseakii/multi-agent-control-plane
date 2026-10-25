import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { openCatalog } from './helpers';
test('explicit real official catalog refresh only downloads metadata', async ({ page }) => {
  const before = (await (await page.request.get('/api/control-center')).json()).executionAttempts;
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await openCatalog(page);
  const catalog = page.getByRole('region', { name: 'ACP 接入目录' });
  const request = page.waitForResponse(
    (r) => r.url().endsWith('/api/agent-catalog/refresh') && r.request().method() === 'POST',
  );
  await catalog.getByRole('button', { name: '刷新官方目录', exact: true }).click();
  const response = await request;
  expect(response.status()).toBe(200);
  const result = await response.json();
  test.info().attach('catalog-refresh-result', {
    body: JSON.stringify({
      source: result.source,
      entries: result.entries?.length,
      error: result.error,
      fetchedAt: result.fetchedAt,
    }),
    contentType: 'application/json',
  });
  if (result.error && process.env.CONTROL_PLANE_A0_EVIDENCE)
    await page.screenshot({
      path: join(process.env.CONTROL_PLANE_A0_EVIDENCE, 'official-catalog-error-1366.png'),
      fullPage: true,
    });
  expect(result.error).toBeNull();
  expect(result.entries.length).toBeGreaterThan(10);
  await catalog.getByLabel('搜索目录').fill('antigravity');
  await expect(
    catalog.getByRole('heading', { name: 'Google Antigravity', exact: true }),
  ).toBeVisible();
  await expect(catalog).toContainText('本机安装/版本未核实');
  if (process.env.CONTROL_PLANE_A0_EVIDENCE)
    await page.screenshot({
      path: join(process.env.CONTROL_PLANE_A0_EVIDENCE, 'official-catalog-1366.png'),
      fullPage: true,
    });
  const state = await (await page.request.get('/api/control-center')).json();
  expect(state.executionAttempts).toEqual(before);
});
