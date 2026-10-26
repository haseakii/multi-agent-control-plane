import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Workspace } from '@control-plane/core';
import { LocalGitLiveChangesReader } from './live-changes.js';

it('observes saved multi-file changes and subsequent edits without staging, commits or repository filters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'live-changes-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'index.html'), '<h1>Before</h1>\n');
    writeFileSync(join(root, 'same.txt'), 'same\n');
    writeFileSync(join(root, 'deleted.txt'), 'delete\n');
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseRevision = git('rev-parse', 'HEAD');
    const workspace: Workspace = {
      id: 'w',
      projectId: 'p',
      provider: 'git-worktree',
      rootPath: root,
      baseRevision,
      access: 'read-write',
    };
    writeFileSync(join(root, 'index.html'), '<h1>First saved edit</h1>\n');
    git('add', 'index.html');
    const index = readFileSync(join(root, '.git', 'index'));
    writeFileSync(join(root, 'same.txt'), 'same\r\n');
    writeFileSync(join(root, 'styles.css'), 'h1 { color: red; }\n');
    writeFileSync(join(root, 'ignored.txt'), 'ignored\n');
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 255, 1]));
    unlinkSync(join(root, 'deleted.txt'));
    writeFileSync(join(root, '.gitattributes'), '*.html filter=probe\n');
    git('config', 'filter.probe.clean', 'echo unsafe > filter-ran.txt');
    git('config', 'filter.probe.required', 'true');
    const reader = new LocalGitLiveChangesReader();
    const first = await reader.read(workspace, 'index.html');
    expect(first.files).toEqual(
      expect.arrayContaining([
        { path: 'index.html', status: 'M' },
        { path: 'styles.css', status: 'A' },
        { path: 'deleted.txt', status: 'D' },
      ]),
    );
    expect(first.files.some((f) => ['same.txt', 'ignored.txt'].includes(f.path))).toBe(false);
    expect(first.detail).toEqual({
      path: 'index.html',
      before: '<h1>Before</h1>\n',
      after: '<h1>First saved edit</h1>\n',
    });
    writeFileSync(join(root, 'index.html'), '<h1>Follow-up saved edit</h1>\n');
    expect((await reader.read(workspace, 'index.html')).detail?.after).toContain(
      'Follow-up saved edit',
    );
    expect((await reader.read(workspace, 'binary.dat')).detail?.note).toContain('二进制');
    expect(existsSync(join(root, 'filter-ran.txt'))).toBe(false);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
    expect(git('rev-parse', 'HEAD')).toBe(baseRevision);
    await expect(reader.read(workspace, '../outside.txt')).rejects.toThrow('不在当前项目');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports uninspected large files explicitly instead of claiming the project is clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'live-large-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-m', 'base');
    writeFileSync(join(root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = await new LocalGitLiveChangesReader().read({
      id: 'w',
      projectId: 'p',
      provider: 'git-worktree',
      rootPath: root,
      baseRevision: git('rev-parse', 'HEAD'),
      access: 'read-write',
    });
    expect(result.files).toEqual([
      { path: 'large.bin', status: 'unknown', note: expect.stringContaining('8 MiB') },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
