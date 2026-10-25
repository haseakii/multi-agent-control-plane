import { AgentMessageSchema } from '@control-plane/core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync) };
});
import { openSqliteStorage, inspectSqliteSnapshot } from '@control-plane/storage';
import { seedDemoState } from './control-center.js';
import { acquireInstanceLock, maintenanceMarker, readReleaseConfig } from './release-config.js';
import {
  backupStoppedRelease,
  backupStoppedLegacyWorkbench,
  restorePrivateBackup,
  verifyPrivateBackup,
} from './release-maintenance.js';

const roots: string[] = [];
const version = '0.1.0';
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(migrationCount?: number) {
  const root = mkdtempSync(join(tmpdir(), 'cp-m2-备份-'));
  roots.push(root);
  const data = join(root, '原始 数据');
  mkdirSync(data);
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ version: 1, port: 43951, dataDir: './原始 数据', logLevel: 'info' }),
  );
  let migrationsFolder: string | undefined;
  if (migrationCount) {
    migrationsFolder = join(root, 'old-migrations');
    mkdirSync(join(migrationsFolder, 'meta'), { recursive: true });
    const source = new URL('../../../packages/storage/drizzle/', import.meta.url);
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', source), 'utf8'));
    journal.entries = journal.entries.slice(0, migrationCount);
    writeFileSync(join(migrationsFolder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(new URL(entry.tag + '.sql', source), join(migrationsFolder, entry.tag + '.sql'));
  }
  const storage = openSqliteStorage({
    filename: join(data, 'control-plane.sqlite'),
    ...(migrationsFolder ? { migrationsFolder } : {}),
  });
  seedDemoState(storage);
  const artifact = storage.repositories.artifacts.list()[0]!;
  storage.close();
  const blob = join(data, 'artifacts', artifact.storageKey);
  mkdirSync(dirname(blob), { recursive: true });
  writeFileSync(blob, 'Demo worker durable result');
  mkdirSync(join(data, 'workspaces'));
  writeFileSync(
    join(data, 'workspaces', 'private-source.txt'),
    'Synthetic workspace is outside backup scope',
  );
  mkdirSync(join(data, 'cache'));
  writeFileSync(join(data, 'cache', 'agent-catalog.json'), 'Synthetic catalog cache excluded');
  mkdirSync(join(data, 'logs'));
  writeFileSync(join(data, 'logs', 'server.log'), 'Synthetic log excluded');
  const unreferenced = join(data, 'artifacts', 'sha256', '00', '0'.repeat(64));
  mkdirSync(dirname(unreferenced), { recursive: true });
  writeFileSync(unreferenced, 'unreferenced');
  return { root, data, config, blob, backup: join(root, '备份 目录') };
}

for (const count of [8, 14])
  it(`restores a known ${count}-migration backup into an upgraded new directory without changing the original`, async () => {
    const f = fixture(count);
    const sourceBefore = fingerprints(f.data);
    await backupStoppedRelease(f.config, f.backup, version);
    const backupBefore = fingerprints(f.backup);
    const verified = await verifyPrivateBackup(f.backup, version);
    expect(verified.pendingMigrations).toBe(16 - count);
    expect(() => inspectSqliteSnapshot(join(f.backup, 'database.sqlite'))).toThrow(
      'Unsupported database migration',
    );
    const target = join(f.root, 'upgraded-restore');
    const result = await restorePrivateBackup(f.backup, target, version);
    expect(result).toMatchObject({ automaticExecution: false, migrationsApplied: 16 - count });
    expect(
      inspectSqliteSnapshot(join(target, 'data/control-plane.sqlite')).migrations,
    ).toHaveLength(16);
    expect(fingerprints(f.data)).toEqual(sourceBefore);
    expect(fingerprints(f.backup)).toEqual(backupBefore);
    expect(readFileSync(join(target, 'RESTORE-INFO.txt'), 'utf8')).toContain('原备份未修改');
    const restored = openSqliteStorage({ filename: join(target, 'data/control-plane.sqlite') });
    try {
      expect(restored.repositories.tasks.list()).toHaveLength(2);
      expect(restored.repositories.executionAttempts.list()).toHaveLength(1);
      expect(restored.repositories.events.listByProject('demo-project')).toHaveLength(5);
    } finally {
      restored.close();
    }
    expect(existsSync(join(target, 'data/instance.lock'))).toBe(false);
  });

it('rejects an altered migration history before activating a restored directory', async () => {
  const f = fixture(14);
  await backupStoppedRelease(f.config, f.backup, version);
  const require = createRequire(new URL('../../../packages/storage/package.json', import.meta.url));
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(join(f.backup, 'database.sqlite'));
  expect(
    db
      .prepare(
        'UPDATE __drizzle_migrations SET hash=? WHERE rowid=(SELECT MIN(rowid) FROM __drizzle_migrations)',
      )
      .run('0'.repeat(64)).changes,
  ).toBe(1);
  db.close();
  const bytes = readFileSync(join(f.backup, 'database.sqlite'));
  modifyManifest(f.backup, (m) => {
    m.migrations[0].hash = '0'.repeat(64);
    const file = m.files.find((item: { path: string }) => item.path === 'database.sqlite');
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.size = bytes.length;
  });
  const before = fingerprints(f.backup);
  const target = join(f.root, 'invalid-restore');
  await expect(restorePrivateBackup(f.backup, target, version)).rejects.toThrow(
    'Unsupported database migration',
  );
  expect(existsSync(target)).toBe(false);
  expect(fingerprints(f.backup)).toEqual(before);
});
function fingerprints(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (item.name === 'instance.lock') continue;
    const path = join(prefix, item.name);
    if (item.isDirectory()) Object.assign(result, fingerprints(root, path));
    else
      result[path] = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
  }
  return result;
}
function modifyManifest(backup: string, change: (value: any) => void) {
  const path = join(backup, 'backup-manifest.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, JSON.stringify(value));
}

function legacyFixture() {
  const f = fixture();
  const run = join(f.root, '旧 Hermes');
  mkdirSync(run);
  const data = join(run, 'data');
  renameSync(f.data, data);
  renameSync(join(data, 'control-plane.sqlite'), join(data, 'state.sqlite'));
  writeFileSync(
    join(run, 'server.json'),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      url: 'http://127.0.0.1:8047',
    }),
  );
  writeFileSync(join(run, 'daily-prompt-usage.json'), 'historical ledger must remain untouched');
  return { ...f, run, data };
}

it('hands stopped legacy data to the same private backup/restore chain without modifying its original DB or ledger', async () => {
  const f = legacyFixture();
  const before = fingerprints(f.run);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No recorded process'), { code: 'ESRCH' });
  });
  try {
    const result = await backupStoppedLegacyWorkbench(f.run, f.backup, version);
    expect(result.sourceLayout).toBe('legacy-hermes');
    expect(result.stopEnforcement).toBe('cooperative-legacy-launcher');
    expect(fingerprints(f.run)).toEqual(before);
    expect((await verifyPrivateBackup(f.backup, version)).manifest.format).toBe(
      'control-plane-private-backup',
    );
    const restored = join(f.root, 'standard-restored');
    await restorePrivateBackup(f.backup, restored, version);
    expect(
      inspectSqliteSnapshot(join(restored, 'data/control-plane.sqlite')).artifacts,
    ).toHaveLength(1);
    expect(existsSync(join(restored, 'data/state.sqlite'))).toBe(false);
    expect(existsSync(join(restored, 'data/workspaces'))).toBe(false);
    // The restored directory is immediately consumable by the original standard backup API.
    await backupStoppedRelease(
      join(restored, 'config.json'),
      join(f.root, 'second-backup'),
      version,
    );
    expect(fingerprints(f.run)).toEqual(before);
  } finally {
    kill.mockRestore();
  }
});

it('refuses a recorded live legacy process without opening its database or creating an output', async () => {
  const f = legacyFixture();
  const before = fingerprints(f.run);
  await expect(backupStoppedLegacyWorkbench(f.run, f.backup, version)).rejects.toThrow(
    'still running',
  );
  expect(existsSync(f.backup)).toBe(false);
  expect(fingerprints(f.run)).toEqual(before);
});

it('backs up a stopped private database and only referenced blobs, restoring into a new empty directory', async () => {
  const f = fixture(),
    before = fingerprints(f.data);
  const result = await backupStoppedRelease(f.config, f.backup, version);
  expect(result.artifacts).toBe(1);
  expect(fingerprints(f.data)).toEqual(before);
  expect(existsSync(join(f.data, 'instance.lock'))).toBe(false);
  const verified = await verifyPrivateBackup(f.backup, version);
  expect(verified.manifest.files).toHaveLength(3);
  expect(existsSync(join(f.backup, 'logs'))).toBe(false);
  expect(existsSync(join(f.backup, 'workspaces'))).toBe(false);
  expect(() => readReleaseConfig(join(f.backup, 'config.snapshot.json'))).toThrow('not runnable');
  const restored = join(f.root, '恢复 空目录');
  mkdirSync(restored);
  await restorePrivateBackup(f.backup, restored, version);
  expect(readReleaseConfig(join(restored, 'config.json')).dataDir).toBe(join(restored, 'data'));
  expect(
    inspectSqliteSnapshot(join(restored, 'data', 'control-plane.sqlite')).artifacts,
  ).toHaveLength(1);
  const artifact = verified.manifest.files.find((item) => item.path.startsWith('artifacts/'))!;
  expect(readFileSync(join(restored, 'data', artifact.path), 'utf8')).toBe(
    'Demo worker durable result',
  );
  expect(existsSync(join(restored, maintenanceMarker))).toBe(false);
  expect(existsSync(join(restored, 'data', 'workspaces'))).toBe(false);
  expect(existsSync(join(restored, 'data', 'cache'))).toBe(false);
  expect(fingerprints(f.data)).toEqual(before);
});

it('refuses an active data lock and never steals it or changes the database', async () => {
  const f = fixture(),
    before = fingerprints(f.data),
    release = acquireInstanceLock(f.data);
  try {
    await expect(backupStoppedRelease(f.config, f.backup, version)).rejects.toThrow('locked');
    expect(existsSync(f.backup)).toBe(false);
    expect(fingerprints(f.data)).toEqual(before);
    expect(existsSync(join(f.data, 'instance.lock'))).toBe(true);
  } finally {
    release();
  }
});

for (const mode of ['missing', 'corrupt'] as const)
  it(`rejects ${mode} referenced source blobs and leaves only a non-runnable partial backup`, async () => {
    const f = fixture();
    if (mode === 'missing') unlinkSync(f.blob);
    else writeFileSync(f.blob, 'damaged');
    const before = fingerprints(f.data);
    await expect(backupStoppedRelease(f.config, f.backup, version)).rejects.toThrow();
    expect(fingerprints(f.data)).toEqual(before);
    expect(existsSync(f.backup)).toBe(false);
    const partial = readdirSync(f.root).find((name) => name.startsWith('备份 目录.partial-'))!;
    expect(existsSync(join(f.root, partial, maintenanceMarker))).toBe(true);
    expect(() => readReleaseConfig(join(f.root, partial, 'config.snapshot.json'))).toThrow(
      'not runnable',
    );
  });

for (const mode of [
  'missing',
  'corrupt',
  'traversal',
  'encoded-traversal',
  'backslash',
  'wrong-format',
  'wrong-app',
  'wrong-migrations',
  'invalid-sqlite',
  'invalid-config',
] as const)
  it(`rejects ${mode} backups without changing original data or activating output`, async () => {
    const f = fixture();
    await backupStoppedRelease(f.config, f.backup, version);
    const before = fingerprints(f.data);
    const manifest = (await verifyPrivateBackup(f.backup, version)).manifest;
    const blob = join(
      f.backup,
      manifest.files.find((item) => item.path.startsWith('artifacts/'))!.path,
    );
    if (mode === 'missing') unlinkSync(blob);
    if (mode === 'corrupt') writeFileSync(blob, 'bad');
    if (mode === 'traversal')
      modifyManifest(f.backup, (m) => (m.files[0].path = '../outside.sqlite'));
    if (mode === 'encoded-traversal')
      modifyManifest(f.backup, (m) => (m.files[0].path = '%2e%2e/outside.sqlite'));
    if (mode === 'backslash')
      modifyManifest(f.backup, (m) => (m.files[0].path = '..\\outside.sqlite'));
    if (mode === 'wrong-format') modifyManifest(f.backup, (m) => (m.version = 99));
    if (mode === 'wrong-app') modifyManifest(f.backup, (m) => (m.applicationVersion = 'future'));
    if (mode === 'wrong-migrations')
      modifyManifest(f.backup, (m) => (m.migrations[0].hash = '0'.repeat(64)));
    if (mode === 'invalid-sqlite' || mode === 'invalid-config') {
      const name = mode === 'invalid-sqlite' ? 'database.sqlite' : 'config.snapshot.json';
      const text =
        mode === 'invalid-sqlite' ? 'not sqlite' : JSON.stringify({ version: 1, host: '0.0.0.0' });
      writeFileSync(join(f.backup, name), text);
      modifyManifest(f.backup, (m) => {
        const item = m.files.find((v: any) => v.path === name);
        item.size = Buffer.byteLength(text);
        item.sha256 = createHash('sha256').update(text).digest('hex');
      });
    }
    const target = join(f.root, '必须不激活');
    await expect(restorePrivateBackup(f.backup, target, version)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(fingerprints(f.data)).toEqual(before);
  });

it('rejects nonempty targets and symbolic link/junction backups without touching either source or target', async () => {
  const f = fixture();
  await backupStoppedRelease(f.config, f.backup, version);
  const target = join(f.root, '已有 数据');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'keep');
  const original = fingerprints(f.data),
    old = fingerprints(target);
  await expect(restorePrivateBackup(f.backup, target, version)).rejects.toThrow('empty');
  expect(fingerprints(target)).toEqual(old);
  const link = join(f.root, 'backup-link');
  symlinkSync(f.backup, link, 'junction');
  await expect(restorePrivateBackup(link, join(f.root, 'linked-target'), version)).rejects.toThrow(
    'links',
  );
  const nested = join(f.backup, 'unexpected-link');
  symlinkSync(join(f.data, 'workspaces'), nested, 'junction');
  await expect(
    restorePrivateBackup(f.backup, join(f.root, 'nested-target'), version),
  ).rejects.toThrow('link');
  expect(fingerprints(f.data)).toEqual(original);
});

it('does not let an outside config start a partial data directory', () => {
  const f = fixture();
  const partial = join(f.root, 'partial', 'data');
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, maintenanceMarker), 'not ready');
  const file = join(f.root, 'outside-config.json');
  writeFileSync(file, JSON.stringify({ version: 1, dataDir: partial }));
  expect(() => readReleaseConfig(file)).toThrow('not runnable');
});

it('recovers committed crash WAL without opening or modifying original SQLite files', async () => {
  const f = fixture();
  const childFile = join(f.root, 'crash-writer.cjs');
  writeFileSync(
    childFile,
    `const Database = require(process.argv[2]);
const db = new Database(process.argv[3]);
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 0');
db.prepare("UPDATE projects SET payload = json_set(payload, '$.name', 'WAL-only committed project')").run();
process.stdout.write('committed');
setInterval(() => {}, 1000);`,
  );
  const native = createRequire(
    new URL('../../../packages/storage/package.json', import.meta.url),
  ).resolve('better-sqlite3');
  const child = spawn(process.execPath, [childFile, native, join(f.data, 'control-plane.sqlite')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic WAL writer timed out')), 10000);
      child.stdout.once('data', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('WAL writer exited early'));
      });
    });
  } finally {
    child.kill();
    await exited;
  }
  expect(existsSync(join(f.data, 'control-plane.sqlite-wal'))).toBe(true);
  const before = fingerprints(f.data);
  await backupStoppedRelease(f.config, f.backup, version);
  expect(fingerprints(f.data)).toEqual(before);
  const restored = join(f.root, 'wal-restored');
  await restorePrivateBackup(f.backup, restored, version);
  const storage = openSqliteStorage({ filename: join(restored, 'data', 'control-plane.sqlite') });
  try {
    expect(storage.repositories.projects.list()[0]?.name).toBe('WAL-only committed project');
  } finally {
    storage.close();
  }
  expect(fingerprints(f.data)).toEqual(before);
});

for (const marker of ['root', 'data'] as const)
  it(`keeps restored data non-runnable if ${marker} activation marker removal fails`, async () => {
    const f = fixture();
    await backupStoppedRelease(f.config, f.backup, version);
    const before = fingerprints(f.data);
    const target = join(f.root, 'activation-failed');
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const blocked = join(target, ...(marker === 'root' ? [] : ['data']), maintenanceMarker);
    vi.mocked(unlinkSync).mockImplementation((path) => {
      if (String(path) === blocked)
        throw Object.assign(new Error('Synthetic marker removal denied'), { code: 'EACCES' });
      real.unlinkSync(path);
    });
    try {
      await expect(restorePrivateBackup(f.backup, target, version)).rejects.toThrow(
        'Synthetic marker',
      );
      expect(existsSync(join(target, 'data', maintenanceMarker))).toBe(true);
      const outside = join(f.root, 'outside-activation-config.json');
      writeFileSync(outside, JSON.stringify({ version: 1, dataDir: join(target, 'data') }));
      expect(() => readReleaseConfig(outside)).toThrow('not runnable');
      expect(() => readReleaseConfig(join(target, 'config.json'))).toThrow('not runnable');
      expect(fingerprints(f.data)).toEqual(before);
    } finally {
      vi.mocked(unlinkSync).mockImplementation(real.unlinkSync);
    }
  });

function addDanglingReference(
  storage: ReturnType<typeof openSqliteStorage>,
  kind: 'message' | 'artifact-link',
) {
  if (kind === 'message') {
    const message = storage.repositories.messages.list()[0]!;
    storage.repositories.messages.upsert(
      AgentMessageSchema.parse({ ...message, artifactRefs: ['missing-artifact'] }),
    );
  } else {
    storage.sqlite
      .prepare(
        'INSERT INTO artifact_links (id,artifact_id,project_id,entity_type,entity_id,created_at,payload) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        'dangling-link',
        'missing-artifact',
        'demo-project',
        'task',
        'demo-root',
        '2026-10-20T00:00:00.000Z',
        '{}',
      );
  }
}
for (const kind of ['message', 'artifact-link'] as const) {
  it(`refuses backup with dangling ${kind} artifact reference without changing source`, async () => {
    const f = fixture();
    const storage = openSqliteStorage({ filename: join(f.data, 'control-plane.sqlite') });
    addDanglingReference(storage, kind);
    storage.close();
    const before = fingerprints(f.data);
    await expect(backupStoppedRelease(f.config, f.backup, version)).rejects.toThrow(
      'missing artifact',
    );
    expect(existsSync(f.backup)).toBe(false);
    expect(fingerprints(f.data)).toEqual(before);
  });
  it(`refuses verify and restore of a checksum-valid database with dangling ${kind} artifact reference`, async () => {
    const f = fixture();
    await backupStoppedRelease(f.config, f.backup, version);
    const before = fingerprints(f.data);
    const storage = openSqliteStorage({ filename: join(f.backup, 'database.sqlite') });
    addDanglingReference(storage, kind);
    storage.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    storage.sqlite.pragma('journal_mode = DELETE');
    storage.close();
    modifyManifest(f.backup, (m) => {
      const db = m.files.find((x: any) => x.path === 'database.sqlite');
      const bytes = readFileSync(join(f.backup, 'database.sqlite'));
      db.size = bytes.length;
      db.sha256 = createHash('sha256').update(bytes).digest('hex');
    });
    await expect(verifyPrivateBackup(f.backup, version)).rejects.toThrow('missing artifact');
    const target = join(f.root, 'dangling-restored');
    await expect(restorePrivateBackup(f.backup, target, version)).rejects.toThrow(
      'missing artifact',
    );
    expect(existsSync(target)).toBe(false);
    expect(fingerprints(f.data)).toEqual(before);
  });
}
