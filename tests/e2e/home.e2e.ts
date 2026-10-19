import { expect, test } from '@playwright/test';

test('web control center renders the bootstrap page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Multi-Agent Control Plane' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('V0 bootstrap is running');
});
