import { defineConfig } from '@playwright/test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONTROL_PLANE_E2E_DATA_DIR ??= mkdtempSync(
  join(realpathSync.native(tmpdir()), 'control-plane-e2e-'),
);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  projects: [
    { name: 'local', testIgnore: '**/acp-official-catalog.e2e.ts' },
    {
      name: 'official-catalog',
      testMatch: '**/acp-official-catalog.e2e.ts',
      dependencies: ['local'],
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: [
    {
      command: 'node --import tsx tests/e2e/server.ts',
      env: {
        CONTROL_PLANE_DEMO: '1',
        HOST: '127.0.0.1',
        PORT: '3000',
        ...(process.env.CONTROL_PLANE_E2E_DATA_DIR
          ? {
              CONTROL_PLANE_ARTIFACTS: process.env.CONTROL_PLANE_E2E_DATA_DIR + '/artifacts',
              CONTROL_PLANE_WORKSPACES: process.env.CONTROL_PLANE_E2E_DATA_DIR + '/workspaces',
            }
          : {}),
        CONTROL_PLANE_DB: process.env.CONTROL_PLANE_E2E_DATA_DIR
          ? process.env.CONTROL_PLANE_E2E_DATA_DIR + '/control-plane.sqlite'
          : '.data/playwright.sqlite',
      },
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
