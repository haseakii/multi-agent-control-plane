import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readWorkspacePage } from './workspace-page.js';
it('reads only the bounded page entry from the selected workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-page-'));
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html><h1>真实页面</h1>');
    expect(new TextDecoder().decode(await readWorkspacePage(root))).toContain('真实页面');
    writeFileSync(join(root, 'index.html'), 'x'.repeat(512 * 1024 + 1));
    await expect(readWorkspacePage(root)).rejects.toThrow('512 KB');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
