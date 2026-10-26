import { expect, test } from '@playwright/test';
import { openContext, showHistory } from './helpers';

test('web control center renders durable multi-agent demo state', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'V0 multi-agent demo', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('status').first()).toContainText(/已连接|实时同步/);

  await page.getByRole('button', { name: '成员与设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '成员连接', exact: true })).toBeVisible();
  await expect(page.locator('.agent-card').filter({ hasText: 'Demo Boss ACP' })).toBeVisible();
  await expect(page.locator('.agent-card').filter({ hasText: 'Demo Worker ACP' })).toBeVisible();

  await page.getByRole('button', { name: '返回任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务记录' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open task Prepare V0 architecture summary', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open task Review control-plane boundaries', exact: true }),
  ).toBeVisible();

  await showHistory(page);
  await expect(page.getByRole('heading', { name: '执行记录' })).toBeVisible();
  await expect(page.getByText('已委派任务', { exact: true })).toBeVisible();
  await expect(page.getByText('执行者已完成', { exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { name: '协作消息' })).toBeVisible();
  await expect(
    page.getByText('Review complete; durable result published as an artifact.'),
  ).toBeVisible();

  await openContext(page);
  await expect(page.getByRole('heading', { name: '审批决定' })).toBeVisible();
  await expect(page.getByText('workspace.write')).toBeVisible();

  await expect(page.getByRole('heading', { name: '项目产物' })).toBeVisible();
  await expect(page.getByText('demo-artifact')).toBeVisible();
});
