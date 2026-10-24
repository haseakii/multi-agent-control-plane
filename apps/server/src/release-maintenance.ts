import { createHash } from 'node:crypto';
import {
  createReadStream,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  createConsistentSqliteSnapshot,
  inspectSqliteSnapshot,
  openSqliteStorage,
} from '@control-plane/storage';
import {
  acquireInstanceLock,
  readReleaseConfig,
  ReleaseConfigSchema,
  maintenanceMarker,
} from './release-config.js';

const FileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const BackupManifestSchema = z
  .object({
    format: z.literal('control-plane-private-backup'),
    version: z.literal(1),
    applicationVersion: z.string().min(1),
    createdAt: z.string().datetime(),
    migrations: z.array(
      z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.number().int() }).strict(),
    ),
    files: z.array(FileSchema).min(2).max(100000),
  })
  .strict();
type BackupFile = z.infer<typeof FileSchema>;
function noLinks(path: string): void {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (lstatMissingLink(current)) throw new Error('Symbolic links are not accepted.');
      break;
    }
    if (lstatSync(current).isSymbolicLink())
      throw new Error('Symbolic links or junctions are not accepted.');
  }
}
function lstatMissingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function isWithin(parent: string, child: string): boolean {
  const local = relative(resolve(parent), resolve(child));
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
}
function disjoint(a: string, b: string): void {
  if (isWithin(a, b) || isWithin(b, a))
    throw new Error('Source and output directories must not overlap.');
}
function newOutput(path: string): string {
  const output = resolve(path);
  noLinks(output);
  if (existsSync(output) && (!statSync(output).isDirectory() || readdirSync(output).length))
    throw new Error('Output must be a new or empty directory.');
  return output;
}
function stageFor(output: string): string {
  mkdirSync(dirname(output), { recursive: true });
  noLinks(dirname(output));
  const stage = mkdtempSync(join(dirname(output), basename(output) + '.partial-'));
  writeFileSync(join(stage, maintenanceMarker), 'Incomplete maintenance output: do not start.');
  return stage;
}
function activate(stage: string, output: string): void {
  newOutput(output);
  if (existsSync(output)) rmdirSync(output);
  renameSync(stage, output);
}
function validPath(path: string): boolean {
  return (
    path === 'database.sqlite' ||
    path === 'config.snapshot.json' ||
    /^artifacts\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(path)
  );
}
async function describeFile(root: string, path: string): Promise<BackupFile> {
  if (!validPath(path)) throw new Error('Invalid backup file path.');
  const full = resolve(root, path);
  if (!isWithin(root, full)) throw new Error('Backup path escapes root.');
  noLinks(full);
  const info = statSync(full);
  if (!info.isFile()) throw new Error('Backup entries must be regular files.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(full)) hash.update(chunk);
  return { path, size: info.size, sha256: hash.digest('hex') };
}
function artifactFiles(info: ReturnType<typeof inspectSqliteSnapshot>) {
  const files = new Map<string, { size: number; sha256: string }>();
  for (const artifact of info.artifacts) {
    const expected = `sha256/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`;
    if (artifact.storageKey !== expected)
      throw new Error('Artifact storage key is not a valid content address.');
    const path = `artifacts/${expected}`;
    const previous = files.get(path);
    if (previous && (previous.size !== artifact.sizeBytes || previous.sha256 !== artifact.sha256))
      throw new Error('Conflicting artifact metadata.');
    files.set(path, { size: artifact.sizeBytes, sha256: artifact.sha256 });
  }
  return files;
}
function copyPrivateFile(source: string, destination: string): void {
  noLinks(source);
  if (!statSync(source).isFile()) throw new Error('Only regular source files are accepted.');
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
function enumerate(root: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    const absolute = join(root, path);
    if (lstatSync(absolute).isSymbolicLink())
      throw new Error('Backup contains a symbolic link or junction.');
    if (item.isDirectory()) result.push(...enumerate(root, path));
    else if (item.isFile()) result.push(path);
    else throw new Error('Backup contains a non-regular entry.');
  }
  return result;
}

export async function verifyPrivateBackup(directory: string, applicationVersion: string) {
  const root = resolve(directory);
  noLinks(root);
  if (!statSync(root).isDirectory()) throw new Error('Backup must be a directory.');
  const manifestPath = join(root, 'backup-manifest.json');
  noLinks(manifestPath);
  if (statSync(manifestPath).size > 16 * 1024 * 1024)
    throw new Error('Backup manifest is too large.');
  const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.applicationVersion !== applicationVersion)
    throw new Error('Unsupported backup application version.');
  const declared = new Set<string>();
  for (const file of manifest.files) {
    if (!validPath(file.path) || declared.has(file.path))
      throw new Error('Invalid or duplicate backup path.');
    declared.add(file.path);
    const actual = await describeFile(root, file.path);
    if (actual.size !== file.size || actual.sha256 !== file.sha256)
      throw new Error('Backup file integrity check failed.');
  }
  if (!declared.has('database.sqlite') || !declared.has('config.snapshot.json'))
    throw new Error('Required backup files are missing.');
  const allowed = new Set([...declared, 'backup-manifest.json', maintenanceMarker]);
  for (const path of enumerate(root))
    if (!allowed.has(path)) throw new Error('Unexpected file in backup.');
  if (!existsSync(join(root, maintenanceMarker)))
    throw new Error('Backup directory marker is missing.');
  const config = ReleaseConfigSchema.parse(
    JSON.parse(readFileSync(join(root, 'config.snapshot.json'), 'utf8')),
  );
  const database = inspectSqliteSnapshot(join(root, 'database.sqlite'), {
    allowKnownUpgrade: true,
  });
  if (JSON.stringify(database.migrations) !== JSON.stringify(manifest.migrations))
    throw new Error('Backup migration manifest mismatch.');
  const artifacts = artifactFiles(database);
  const expected = new Set(['database.sqlite', 'config.snapshot.json', ...artifacts.keys()]);
  if (expected.size !== declared.size || [...expected].some((path) => !declared.has(path)))
    throw new Error('Backup artifact reference list is incomplete.');
  for (const [path, metadata] of artifacts) {
    const item = manifest.files.find((file) => file.path === path)!;
    if (item.sha256 !== metadata.sha256 || item.size !== metadata.size)
      throw new Error('Artifact content does not match database metadata.');
  }
  return { manifest, config, artifacts, pendingMigrations: database.pendingMigrations };
}

export async function backupStoppedRelease(
  configFile: string,
  outputDirectory: string,
  applicationVersion: string,
) {
  noLinks(configFile);
  const config = readReleaseConfig(configFile);
  noLinks(config.dataDir);
  const source = join(config.dataDir, 'control-plane.sqlite');
  noLinks(source);
  if (!existsSync(source)) throw new Error('Source database does not exist.');
  const output = newOutput(outputDirectory);
  disjoint(config.dataDir, output);
  const release = acquireInstanceLock(config.dataDir, configFile);
  try {
    const savedConfig = ReleaseConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
    return await writeStoppedBackup(
      config.dataDir,
      source,
      output,
      savedConfig,
      applicationVersion,
    );
  } finally {
    release();
  }
}

const LegacyInstanceSchema = z.object({
  pid: z.number().int().positive().max(2147483647),
  startedAt: z.string().datetime(),
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
});
const LegacyBackupInputSchema = z
  .object({
    runDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1),
    applicationVersion: z.string().trim().min(1),
  })
  .strict();
function assertLegacyStopped(run: string): void {
  const metadata = join(run, 'server.json');
  noLinks(metadata);
  const record = LegacyInstanceSchema.parse(JSON.parse(readFileSync(metadata, 'utf8')));
  const port = Number(new URL(record.url).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid legacy instance port.');
  // PID reuse is deliberately conservative: a live or inaccessible PID always refuses.
  // This checks the recorded instance only. Operators must keep old unlocked launchers stopped.
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error('Cannot confirm the recorded legacy instance exited.');
  }
  throw new Error('Recorded legacy instance is still running; stop it before backup.');
}

/** Explicit, offline handover. Produces the existing backup format; never renames the source DB. */
export async function backupStoppedLegacyWorkbench(
  runDirectory: string,
  outputDirectory: string,
  applicationVersion: string,
) {
  const input = LegacyBackupInputSchema.parse({
    runDirectory,
    outputDirectory,
    applicationVersion,
  });
  const run = resolve(input.runDirectory);
  const data = join(run, 'data');
  noLinks(run);
  noLinks(data);
  const source = join(data, 'state.sqlite');
  noLinks(source);
  if (!existsSync(source)) throw new Error('Legacy state.sqlite does not exist.');
  if (existsSync(join(data, 'control-plane.sqlite')))
    throw new Error('Mixed legacy and standard databases; refusing ambiguous handover.');
  if (existsSync(join(run, maintenanceMarker)))
    throw new Error('Incomplete maintenance directory is not a legacy run directory.');
  const output = newOutput(input.outputDirectory);
  disjoint(run, output);
  assertLegacyStopped(run);
  const release = acquireInstanceLock(data);
  try {
    assertLegacyStopped(run);
    if (existsSync(join(data, 'control-plane.sqlite')) || existsSync(join(run, maintenanceMarker)))
      throw new Error('Legacy source layout changed before lock acquisition; refusing handover.');
    const config = ReleaseConfigSchema.parse({ version: 1, dataDir: './data' });
    return {
      ...(await writeStoppedBackup(data, source, output, config, input.applicationVersion)),
      sourceLayout: 'legacy-hermes',
      stopEnforcement: 'cooperative-legacy-launcher',
    };
  } finally {
    release();
  }
}

async function writeStoppedBackup(
  dataDir: string,
  source: string,
  output: string,
  savedConfig: z.infer<typeof ReleaseConfigSchema>,
  applicationVersion: string,
) {
  let stage: string | undefined;
  try {
    stage = stageFor(output);
    await createConsistentSqliteSnapshot(source, join(stage, 'database.sqlite'));
    const info = inspectSqliteSnapshot(join(stage, 'database.sqlite'), { allowKnownUpgrade: true });
    const blobs = artifactFiles(info);
    writeFileSync(join(stage, 'config.snapshot.json'), JSON.stringify(savedConfig, null, 2));
    for (const [path, metadata] of blobs) {
      copyPrivateFile(join(dataDir, path), join(stage, path));
      const copied = await describeFile(stage, path);
      if (copied.size !== metadata.size || copied.sha256 !== metadata.sha256)
        throw new Error('Missing or corrupt referenced artifact.');
    }
    const files: BackupFile[] = [];
    for (const path of ['database.sqlite', 'config.snapshot.json', ...blobs.keys()])
      files.push(await describeFile(stage, path));
    const manifest = BackupManifestSchema.parse({
      format: 'control-plane-private-backup',
      version: 1,
      applicationVersion,
      createdAt: new Date().toISOString(),
      migrations: info.migrations,
      files,
    });
    writeFileSync(join(stage, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
    await verifyPrivateBackup(stage, applicationVersion);
    activate(stage, output);
    return {
      operation: 'backup',
      output,
      artifacts: blobs.size,
      files: files.length,
      privateData: true,
    };
  } catch (error) {
    if (stage) console.error(`Incomplete backup retained, not runnable: ${stage}`);
    throw error;
  }
}

export async function restorePrivateBackup(
  backupDirectory: string,
  outputDirectory: string,
  applicationVersion: string,
) {
  const backup = resolve(backupDirectory),
    output = newOutput(outputDirectory);
  disjoint(backup, output);
  const verified = await verifyPrivateBackup(backup, applicationVersion);
  const stage = stageFor(output);
  const data = join(stage, 'data');
  mkdirSync(data);
  writeFileSync(join(data, maintenanceMarker), 'Incomplete restore: do not start.');
  try {
    copyPrivateFile(join(backup, 'database.sqlite'), join(data, 'control-plane.sqlite'));
    for (const path of verified.artifacts.keys())
      copyPrivateFile(join(backup, path), join(data, path));
    const info = inspectSqliteSnapshot(join(data, 'control-plane.sqlite'), {
      allowKnownUpgrade: true,
    });
    if (JSON.stringify(info.migrations) !== JSON.stringify(verified.manifest.migrations))
      throw new Error('Restored migration mismatch.');
    const db = verified.manifest.files.find((file) => file.path === 'database.sqlite')!;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(data, 'control-plane.sqlite')))
      hash.update(chunk);
    if (hash.digest('hex') !== db.sha256) throw new Error('Restored database checksum mismatch.');
    // The source and copied bytes are verified before changing only the private destination.
    if (verified.pendingMigrations) {
      const upgraded = openSqliteStorage({ filename: join(data, 'control-plane.sqlite') });
      upgraded.close();
      const checked = inspectSqliteSnapshot(join(data, 'control-plane.sqlite'));
      if (
        checked.migrations.length !==
          verified.manifest.migrations.length + verified.pendingMigrations ||
        JSON.stringify(checked.artifacts) !== JSON.stringify(info.artifacts)
      )
        throw new Error('Restored database upgrade verification failed.');
    }
    for (const [path, metadata] of verified.artifacts) {
      const file = await describeFile(data, path);
      if (file.sha256 !== metadata.sha256 || file.size !== metadata.size)
        throw new Error('Restored artifact checksum mismatch.');
    }
    const config = ReleaseConfigSchema.parse({ ...verified.config, dataDir: './data' });
    writeFileSync(join(stage, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(
      join(stage, 'RESTORE-INFO.txt'),
      `恢复已完成。${verified.pendingMigrations ? `恢复目录中的数据库已应用 ${verified.pendingMigrations} 项已知升级，原备份未修改。` : '数据库版本无需升级。'}\n` +
        'Private database contents were preserved, not redacted. Workspace source, logs and external Agent installs/logins were NOT backed up. Runtime/workspace metadata may refer to original external paths. Verify those paths before explicit execution. No task or Agent was automatically replayed.',
    );
    activate(stage, output);
    // Data is the final activation barrier, including for external configs.
    unlinkSync(join(output, maintenanceMarker));
    unlinkSync(join(output, 'data', maintenanceMarker));
    return {
      operation: 'restore',
      output,
      config: join(output, 'config.json'),
      artifacts: verified.artifacts.size,
      privateData: true,
      automaticExecution: false,
      migrationsApplied: verified.pendingMigrations,
    };
  } catch (error) {
    console.error(
      `Restore failed; original data unchanged. Incomplete output is not runnable: ${existsSync(stage) ? stage : output}`,
    );
    throw error;
  }
}

export async function runMaintenanceCommand(args: string[], bundleRoot: string): Promise<boolean> {
  const operation = args[0];
  if (operation !== 'backup' && operation !== 'restore' && operation !== 'backup-legacy-hermes')
    return false;
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--config', '--output', '--backup', '--legacy-run'].includes(key) ||
      !value ||
      flags.has(key)
    )
      throw new Error('Invalid maintenance arguments.');
    flags.set(key, value);
  }
  if (!flags.has('--output'))
    throw new Error('Maintenance requires --output NEW_OR_EMPTY_DIRECTORY.');
  const version = JSON.parse(readFileSync(join(bundleRoot, 'package.json'), 'utf8'))
    .version as string;
  if (operation === 'backup') {
    if (flags.has('--backup') || flags.has('--legacy-run'))
      throw new Error('backup accepts --config and --output only.');
    console.log(
      JSON.stringify(
        await backupStoppedRelease(
          flags.get('--config') ?? join(bundleRoot, 'config.json'),
          flags.get('--output')!,
          version,
        ),
      ),
    );
  } else if (operation === 'backup-legacy-hermes') {
    if (!flags.has('--legacy-run') || flags.has('--config') || flags.has('--backup'))
      throw new Error(
        'backup-legacy-hermes requires --legacy-run and --output only. Keep all old launchers stopped.',
      );
    console.log(
      JSON.stringify(
        await backupStoppedLegacyWorkbench(
          flags.get('--legacy-run')!,
          flags.get('--output')!,
          version,
        ),
      ),
    );
  } else {
    if (!flags.has('--backup') || flags.has('--config') || flags.has('--legacy-run'))
      throw new Error('restore requires --backup and --output only.');
    console.log(
      JSON.stringify(
        await restorePrivateBackup(flags.get('--backup')!, flags.get('--output')!, version),
      ),
    );
  }
  return true;
}
