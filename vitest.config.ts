import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Windows may launch the runner with an 8.3 TEMP alias. Fixtures should register
// canonical workspace paths, just as the production directory picker does;
// otherwise identity checks reject every generated workspace before execution.
const testTemp = realpathSync.native(tmpdir());

export default defineConfig({
  // The Hermes overlay is compiled inside upstream web; reuse the workspace's
  // installed validation library when its pure configuration helpers run here.
  resolve: {
    alias: {
      zod: createRequire(new URL('./apps/server/package.json', import.meta.url)).resolve('zod'),
    },
  },
  test: {
    // Real Git, ACP and native Windows fixtures share the machine's process/IO
    // budget. Bound workers so unrelated fixture startup cannot starve a test.
    maxWorkers: 2,
    env: process.platform === 'win32' ? { TEMP: testTemp, TMP: testTemp } : {},
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'integrations/hermes-workbench/tests/*.test.{ts,mjs}',
    ],
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
    server: {
      deps: {
        inline: ['@control-plane/storage'],
      },
    },
  },
});
