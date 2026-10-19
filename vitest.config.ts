import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
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
