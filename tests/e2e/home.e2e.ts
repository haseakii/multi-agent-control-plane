import { expect, test } from '@playwright/test';

test('web control center renders durable multi-agent demo state', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Multi-Agent Control Plane' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Control plane online');

  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByText('Demo Boss ACP')).toBeVisible();
  await expect(page.getByText('Demo Worker ACP')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByText('Prepare V0 architecture summary')).toBeVisible();
  await expect(page.getByText('Review control-plane boundaries')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Execution timeline' })).toBeVisible();
  await expect(page.getByText('task.delegated')).toBeVisible();
  await expect(page.getByText('worker.completed')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
  await expect(
    page.getByText('Review complete; durable result published as an artifact.'),
  ).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  await expect(page.getByText('workspace.write')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  await expect(page.getByText('demo-artifact')).toBeVisible();
});
