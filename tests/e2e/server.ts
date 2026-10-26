import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogFixture } from './catalog-fixture.js';

// Seed only this run's private metadata cache. Registration/probe still use the
// real application services and synthetic ACP executable; no model prompts.
const root = process.env.CONTROL_PLANE_E2E_DATA_DIR;
if (!root || resolve(process.env.CONTROL_PLANE_DB ?? '') !== resolve(root, 'control-plane.sqlite'))
  throw new Error('E2E server requires its dedicated data directory.');
mkdirSync(join(root, 'cache'), { recursive: true });
writeFileSync(
  join(root, 'cache/agent-catalog.json'),
  JSON.stringify({
    format: 1,
    source: catalogFixture.source,
    fetchedAt: new Date().toISOString(),
    registry: { version: '1.0.0', agents: catalogFixture.entries },
  }),
  { flag: 'wx' },
);
void import('../../apps/server/src/main.js').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
