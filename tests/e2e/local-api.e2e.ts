import { expect, test } from '@playwright/test';

// Exercise the real Vite proxy and API: intercepted snapshots cannot catch a
// proxy Host rewrite breaking the server's same-origin check on browser POSTs.
test('creates a project through the real development proxy and restores it on refresh', async ({
  page,
}) => {
  const name = `Proxy acceptance ${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Control plane online');
  await page.getByLabel('Project name', { exact: true }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/projects',
  );
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const project = (await response.json()) as { id: string };
  await expect(page.getByLabel('Active project')).toHaveValue(project.id);
  await expect(page.getByLabel('Active project').locator('option:checked')).toHaveText(name);
  await page.reload();
  await expect(page.getByLabel('Active project').locator('option')).toContainText([name]);

  // Both the proxy and direct API retain the existing browser-origin boundary.
  for (const headers of [
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { origin: 'http://127.0.0.1:9999' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'attacker.example' },
  ]) {
    for (const origin of ['http://127.0.0.1:4173', 'http://127.0.0.1:3000']) {
      const denied = await page.request.post(`${origin}/api/projects`, {
        headers,
        data: { name: 'Blocked cross-origin project' },
      });
      expect(denied.status()).toBe(403);
    }
  }
});
