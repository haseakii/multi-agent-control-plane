import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readReleaseWorkbench } from './release-workbench.js';

it('serves daily Hermes build metadata without introducing a prompt allowance or changing classic releases', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-workbench-'));
  try {
    expect(readReleaseWorkbench(root)).toBeUndefined();
    const descriptor = {
      version: 1,
      workbench: 'hermes',
      mode: 'real',
      profile: 'daily',
      uiBuildId: '2026-10-23T00:00:00.000Z',
    };
    writeFileSync(join(root, 'workbench.json'), JSON.stringify(descriptor));
    expect(readReleaseWorkbench(root)).toEqual(descriptor);
    writeFileSync(
      join(root, 'workbench.json'),
      JSON.stringify({ ...descriptor, profile: 'acceptance' }),
    );
    expect(() => readReleaseWorkbench(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
