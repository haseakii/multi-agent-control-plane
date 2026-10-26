import { expect, test } from '@playwright/test';
import { openProjectForm } from './helpers';

// Exercise the real Vite proxy and API: intercepted snapshots cannot catch a
// proxy Host rewrite breaking the server's same-origin check on browser POSTs.
test('creates a project through the real development proxy and restores it on refresh', async ({
  page,
}) => {
  const name = `Proxy acceptance ${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('status').first()).toContainText(/已连接|实时同步/);
  await openProjectForm(page);
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/projects',
  );
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const project = (await response.json()) as { id: string };
  await expect(page.getByLabel('当前项目')).toHaveValue(project.id);
  await expect(page.getByLabel('当前项目').locator('option:checked')).toHaveText(name);
  await page.reload();
  await expect(page.getByLabel('当前项目').locator('option')).toContainText([name]);

  // Both the proxy and direct API retain the existing browser-origin boundary.
  const deniedHeaders: Array<Record<string, string>> = [
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { origin: 'http://127.0.0.1:9999' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'attacker.example' },
  ];
  for (const headers of deniedHeaders) {
    for (const origin of ['http://127.0.0.1:4173', 'http://127.0.0.1:3000']) {
      const denied = await page.request.post(`${origin}/api/projects`, {
        headers,
        data: { name: 'Blocked cross-origin project' },
      });
      expect(denied.status()).toBe(403);
    }
  }
});
