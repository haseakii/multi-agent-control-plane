import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage, SqliteStorage } from './database.js';

/** Caller must hold the application's data lock after its runtime has stopped. */
export async function createConsistentSqliteSnapshot(
  source: string,
  destination: string,
): Promise<void> {
  if (existsSync(destination)) throw new Error('Snapshot destination already exists.');
  const parent = resolve(dirname(destination));
  const working = mkdtempSync(join(parent, 'sqlite-source-'));
  const privateSource = join(working, 'source.sqlite');
  let sqlite: Database.Database | undefined;
  try {
    // Even readonly WAL opens may create SHM. Never open the original files:
    // stage the stopped DB and its existing WAL, then let SQLite read/recover
    // only this private copy and produce a self-contained backup snapshot.
    for (const suffix of ['', '-wal']) {
      const file = source + suffix;
      if (suffix && !existsSync(file)) continue;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('SQLite source files must be regular files.');
      copyFileSync(file, privateSource + suffix);
    }
    sqlite = new Database(privateSource, { fileMustExist: true });
    await sqlite.backup(destination);
    sqlite.close();
    sqlite = undefined;
    const snapshot = new Database(destination, { fileMustExist: true });
    try {
      snapshot.pragma('journal_mode = DELETE');
    } finally {
      snapshot.close();
    }
  } finally {
    sqlite?.close();
    const local = relative(parent, resolve(working));
    if (local.startsWith('sqlite-source-') && !local.includes(sep))
      rmSync(working, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Known older snapshots are validated on a private upgraded copy, never in place. */
export function inspectSqliteSnapshot(
  filename: string,
  options: { allowKnownUpgrade?: boolean } = {},
): {
  migrations: Array<{ hash: string; created_at: number }>;
  artifacts: ReturnType<SqliteStorage['repositories']['artifacts']['list']>;
  pendingMigrations: number;
} {
  if (options.allowKnownUpgrade !== undefined && typeof options.allowKnownUpgrade !== 'boolean')
    throw new TypeError('allowKnownUpgrade must be a boolean.');
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error('SQLite integrity check failed.');
    if ((sqlite.pragma('foreign_key_check') as unknown[]).length)
      throw new Error('SQLite foreign key check failed.');
    const migrations = sqlite
      .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id')
      .all() as Array<{ hash: string; created_at: number }>;
    const supported = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
    }).map((item) => ({ hash: item.hash, created_at: item.folderMillis }));
    if (JSON.stringify(migrations) !== JSON.stringify(supported)) {
      const knownPrefix =
        migrations.length > 0 &&
        migrations.length < supported.length &&
        JSON.stringify(migrations) === JSON.stringify(supported.slice(0, migrations.length));
      if (!options.allowKnownUpgrade || !knownPrefix)
        throw new Error('Unsupported database migration version. No migrations were applied.');
      if (existsSync(filename + '-wal'))
        throw new Error('Upgrade inspection requires a standalone backup snapshot.');
      const working = mkdtempSync(join(tmpdir(), 'cp-snapshot-check-'));
      try {
        const copy = join(working, 'snapshot.sqlite');
        copyFileSync(filename, copy);
        const upgraded = openSqliteStorage({ filename: copy });
        upgraded.close();
        const checked = inspectSqliteSnapshot(copy);
        return { ...checked, migrations, pendingMigrations: supported.length - migrations.length };
      } finally {
        const local = relative(resolve(tmpdir()), resolve(working));
        if (local.startsWith('cp-snapshot-check-') && !local.includes(sep))
          rmSync(working, { recursive: true, force: true });
      }
    }
    const repositories = new SqliteStorage(sqlite).repositories;
    for (const policy of repositories.projectPolicies.list())
      if (!repositories.projects.get(policy.id))
        throw new Error('Project policy owner is missing.');
    for (const binding of repositories.workspaceDirectoryBindings.list()) {
      const workspace = repositories.workspaces.get(binding.id);
      if (
        !workspace ||
        workspace.projectId !== binding.projectId ||
        workspace.rootPath !== binding.rootPath
      )
        throw new Error('External workspace binding metadata is inconsistent.');
    }
    for (const config of repositories.projectWorkspaceConfigs.list()) {
      if (repositories.workspaces.get(config.sourceWorkspaceId)?.projectId !== config.id)
        throw new Error('Project workspace configuration is inconsistent.');
    }
    for (const binding of repositories.assignmentWorkspaces.list()) {
      if (
        repositories.assignments.get(binding.id)?.taskId !== binding.taskId ||
        repositories.tasks.get(binding.taskId)?.projectId !== binding.projectId ||
        repositories.workspaces.get(binding.workspaceId)?.projectId !== binding.projectId ||
        repositories.workspaces.get(binding.sourceWorkspaceId)?.projectId !== binding.projectId
      )
        throw new Error('Assignment workspace binding is inconsistent.');
    }
    for (const instruction of repositories.taskInstructions.list()) {
      const task = repositories.tasks.get(instruction.taskId);
      const attempt = instruction.ownerAttemptId
        ? repositories.executionAttempts.get(instruction.ownerAttemptId)
        : undefined;
      if (
        !task ||
        task.projectId !== instruction.projectId ||
        (instruction.ownerAttemptId && attempt?.taskId !== task.id)
      )
        throw new Error('Task instruction ownership metadata is inconsistent.');
    }
    const artifacts = repositories.artifacts.list();
    for (const review of repositories.workspaceReviews.list()) {
      if (
        repositories.tasks.get(review.taskId)?.projectId !== review.projectId ||
        repositories.assignments.get(review.assignmentId)?.taskId !== review.taskId ||
        repositories.workspaces.get(review.workspaceId)?.projectId !== review.projectId ||
        repositories.workspaces.get(review.sourceWorkspaceId)?.projectId !== review.projectId ||
        repositories.artifacts.get(review.patchArtifactId)?.projectId !== review.projectId ||
        repositories.artifacts.get(review.manifestArtifactId)?.projectId !== review.projectId ||
        repositories.approvals.get(review.approvalId)?.projectId !== review.projectId
      )
        throw new Error('Workspace review references are inconsistent.');
    }
    for (const memory of repositories.projectMemory.list()) {
      if (
        !repositories.projects.get(memory.projectId) ||
        (memory.sourceTaskId &&
          repositories.tasks.get(memory.sourceTaskId)?.projectId !== memory.projectId) ||
        memory.sourceArtifactIds.some(
          (id) => repositories.artifacts.get(id)?.projectId !== memory.projectId,
        ) ||
        (memory.supersedesId &&
          repositories.projectMemory.get(memory.supersedesId)?.projectId !== memory.projectId)
      )
        throw new Error('Project memory provenance is inconsistent.');
    }
    const ids = new Set<string>(artifacts.map((artifact) => artifact.id));
    for (const task of repositories.tasks.list())
      if (task.resultArtifactRefs.some((id) => !ids.has(id)))
        throw new Error('Task refers to missing artifact metadata.');
    for (const message of repositories.messages.list())
      if (message.artifactRefs.some((id) => !ids.has(id)))
        throw new Error('Message refers to missing artifact metadata.');
    const links = sqlite.prepare('SELECT artifact_id FROM artifact_links').all() as Array<{
      artifact_id: string;
    }>;
    if (links.some((link) => !ids.has(link.artifact_id)))
      throw new Error('Artifact link refers to missing artifact metadata.');
    return { migrations, artifacts, pendingMigrations: 0 };
  } finally {
    sqlite.close();
  }
}
