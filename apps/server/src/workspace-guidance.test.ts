import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalWorkspaceInventory, workspaceGuidance } from './workspace-guidance.js';
it('lists actual project paths without following Git pointers or inventing package.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-inventory-'));
  try {
    await mkdir(join(dir, 'js'));
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'index.html'), 'private contents not in prompt');
    await writeFile(join(dir, 'js', 'app.js'), '');
    await writeFile(join(dir, '.git', 'HEAD'), 'outside metadata');
    const inventory = new LocalWorkspaceInventory();
    expect(await inventory.list(dir)).toEqual({
      paths: ['index.html', 'js/', 'js/app.js'],
      truncated: false,
    });
    const guidance = await workspaceGuidance(dir, inventory);
    expect(guidance).toContain('Do not follow .git pointers');
    expect(guidance).not.toContain('private contents');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('does not report an unreadable inventory as an empty project', async () => {
  const text = await workspaceGuidance('synthetic', {
    list: async () => {
      throw Error('private');
    },
  });
  expect(text).toContain('"truncated":true');
  expect(text).not.toContain('private');
});
