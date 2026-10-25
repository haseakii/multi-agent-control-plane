import { defineConfig } from '@playwright/test';
import local from './playwright.config';

// External registry availability is an explicit integration check, separate
// from the deterministic local-first quality gate. Both use fresh private data.
export default defineConfig({
  ...local,
  projects: [{ name: 'official-catalog', testMatch: '**/acp-official-catalog.e2e.ts' }],
});
