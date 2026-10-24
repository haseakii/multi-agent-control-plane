import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { openSqliteStorage, inspectSqliteSnapshot } from '@control-plane/storage';
import {
  backupStoppedRelease,
  restorePrivateBackup,
  verifyPrivateBackup,
} from './release-maintenance.js';
import { LocalDirectoryBindings } from './local-directory-binding.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error('Unsafe synthetic cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it('B0 private backup preserves binding metadata, excludes external source, and restore requires rechecking unavailable paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-b0-backup-'));
  roots.push(root);
  const data = join(root, 'data'),
    external = join(root, '合成 existing');
  mkdirSync(data);
  mkdirSync(external);
  writeFileSync(join(external, 'synthetic.txt'), 'private synthetic source excluded');
  const actual = realpathSync.native(external),
    stat = statSync(actual, { bigint: true });
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ version: 1, port: 43952, dataDir: './data', logLevel: 'info' }),
  );
  const db = openSqliteStorage({ filename: join(data, 'control-plane.sqlite') });
  db.repositories.projects.upsert({
    id: 'project',
    name: 'synthetic',
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
  });
  db.repositories.workspaces.upsert({
    id: 'workspace',
    projectId: 'project',
    rootPath: actual,
    provider: 'local-directory',
    access: 'read-write',
  });
  const binding = {
    id: 'workspace',
    projectId: 'project',
    rootPath: actual,
    pathKey: actual.toLowerCase(),
    deviceId: String(stat.dev),
    fileId: String(stat.ino),
    createdAt: '2026-10-21T00:00:00Z',
  };
  db.repositories.workspaceDirectoryBindings.upsert(binding);
  db.close();
  const backup = join(root, 'backup');
  await backupStoppedRelease(config, backup, '0.1.0');
  const verified = await verifyPrivateBackup(backup, '0.1.0');
  expect(
    verified.manifest.files
      .map((f) => f.path)
      .every((p) => p === 'database.sqlite' || p === 'config.snapshot.json'),
  ).toBe(true);
  expect(readFileSync(join(external, 'synthetic.txt'), 'utf8')).toBe(
    'private synthetic source excluded',
  );
  expect(readdirSync(external)).toEqual(['synthetic.txt']);
  renameSync(external, external + '-offline');
  const restored = join(root, 'restored');
  await restorePrivateBackup(backup, restored, '0.1.0');
  expect(inspectSqliteSnapshot(join(restored, 'data', 'control-plane.sqlite'))).toBeDefined();
  const restoredDb = openSqliteStorage({
    filename: join(restored, 'data', 'control-plane.sqlite'),
  });
  try {
    expect(restoredDb.repositories.workspaceDirectoryBindings.get('workspace')).toEqual(binding);
    expect(restoredDb.repositories.tasks.list()).toEqual([]);
    expect(readdirSync(restored).sort()).toEqual(['RESTORE-INFO.txt', 'config.json', 'data']);
    const service = new LocalDirectoryBindings(restoredDb, [join(restored, 'data')]);
    expect(() => service.inspect(actual)).toThrow(/Directory/);
  } finally {
    restoredDb.close();
  }
  const inconsistent = openSqliteStorage({
    filename: join(restored, 'data', 'control-plane.sqlite'),
  });
  inconsistent.repositories.workspaceDirectoryBindings.upsert({
    ...binding,
    rootPath: actual + '-mismatch',
  });
  inconsistent.close();
  expect(() => inspectSqliteSnapshot(join(restored, 'data', 'control-plane.sqlite'))).toThrow(
    /binding metadata is inconsistent/,
  );
});
