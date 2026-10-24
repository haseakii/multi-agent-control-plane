import { expect, test } from '@playwright/test';

test('web control center renders durable multi-agent demo state', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Multi-Agent Control Plane' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Control plane online');

  await page.getByRole('button', { name: 'Agent & project settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.locator('.agent-card').filter({ hasText: 'Demo Boss ACP' })).toBeVisible();
  await expect(page.locator('.agent-card').filter({ hasText: 'Demo Worker ACP' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open task Prepare V0 architecture summary', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open task Review control-plane boundaries', exact: true }),
  ).toBeVisible();

  await expect(page.getByRole('heading', { name: '执行记录' })).toBeVisible();
  await expect(page.getByText('已委派任务', { exact: true })).toBeVisible();
  await expect(page.getByText('执行者已完成', { exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
  await expect(
    page.getByText('Review complete; durable result published as an artifact.'),
  ).toBeVisible();

  await expect(page.getByRole('heading', { name: '审批决定' })).toBeVisible();
  await expect(page.getByText('workspace.write')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  await expect(page.getByText('demo-artifact')).toBeVisible();
});
