import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx apps/server/src/main.ts',
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
      command: 'pnpm --filter @control-plane/web dev:e2e',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
