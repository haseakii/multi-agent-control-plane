import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const absolute = (value) =>
  typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function atomicJson(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
export function parseTarget(value) {
  if (
    !value ||
    !absolute(value.releaseDir) ||
    !absolute(value.configFile) ||
    !uuid(value.generationId) ||
    !/^[a-f0-9]{64}$/.test(value.releaseId ?? '')
  )
    throw Error('Invalid installation target.');
  return value;
}
export function parseInstallation(value) {
  if (!value || value.version !== 1 || !uuid(value.id) || !absolute(value.runtimeFile))
    throw Error('Unsupported installation record. Preserve the original file.');
  parseTarget(value.current);
  if (value.previous) parseTarget(value.previous);
  if (value.connectionFile !== undefined && !absolute(value.connectionFile))
    throw Error('Invalid connection reference.');
  if (
    !value.environment ||
    typeof value.environment !== 'object' ||
    Array.isArray(value.environment)
  )
    throw Error('Invalid launch environment.');
  for (const [key, entry] of Object.entries(value.environment))
    if (!/^(?:[A-Z][A-Z0-9_]*_(?:HOME|DIR)|HOME|USERPROFILE)$/.test(key) || !absolute(entry))
      throw Error('Only local profile/directory references are accepted.');
  return value;
}
export function inside(root, target) {
  const local = path.relative(path.resolve(root), path.resolve(target));
  return !path.isAbsolute(local) && local !== '..' && !local.startsWith('..' + path.sep);
}
export function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error('Expected a regular installation file: ' + file);
  return stat;
}
export function copyReleaseDirectory(source, destination) {
  if (
    !absolute(source) ||
    !absolute(destination) ||
    inside(source, destination) ||
    inside(destination, source)
  )
    throw Error('Release copy requires separate absolute directories.');
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    // Node 22.22.2's native Windows directory-copy path aborts on Unicode
    // directories (0xC0000409). A filter selects its supported JS traversal.
    ...(process.platform === 'win32' ? { filter: () => true } : {}),
  });
}
export function validatePackage(directory, { legacy = false, copyInProgress = false } = {}) {
  const root = fs.realpathSync(directory);
  const manifestFile = path.join(root, 'release-manifest.json');
  regular(manifestFile);
  const manifest = readJson(manifestFile);
  if (
    manifest.format !== 'windows-directory-m1' ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64'
  )
    throw Error('Unsupported release package.');
  for (const file of [
    'runtime/node.exe',
    'apps/server/dist/release-main.js',
    'apps/web/dist/index.html',
  ])
    regular(path.join(root, file));
  if (hash(fs.readFileSync(path.join(root, 'runtime/node.exe'))) !== manifest.nodeSha256)
    throw Error('Runtime integrity check failed.');
  if (!legacy || manifest.files) {
    if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000)
      throw Error('Release file inventory missing; publish a complete new package first.');
    const seen = new Set();
    for (const item of manifest.files) {
      if (
        typeof item.path !== 'string' ||
        item.path.includes('\\') ||
        item.path.split('/').some((p) => !p || p === '.' || p === '..') ||
        !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') ||
        seen.has(item.path)
      )
        throw Error('Invalid release file inventory.');
      const file = path.resolve(root, item.path);
      if (
        !inside(root, file) ||
        fs.realpathSync(file) !== file ||
        regular(file).size !== item.size ||
        hash(fs.readFileSync(file)) !== item.sha256
      )
        throw Error('Release file integrity check failed: ' + item.path);
      seen.add(item.path);
    }
    for (const required of [
      'runtime/node.exe',
      'apps/server/dist/release-main.js',
      'apps/web/dist/index.html',
      'launcher/control-plane.mjs',
    ])
      if (!seen.has(required)) throw Error('Incomplete managed release.');
    const visit = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name,
          full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw Error('Release links are not accepted.');
        if (entry.isDirectory()) visit(full, name + '/');
        else if (
          !entry.isFile() ||
          (!seen.has(name) &&
            name !== 'release-manifest.json' &&
            !(copyInProgress && name === 'NOT-A-RELEASE'))
        )
          throw Error(
            'Unexpected release file: ' +
              name +
              (name.startsWith('data/')
                ? '\n该发布目录已包含运行数据。请保留整个原目录，从原 ZIP 重新完整解压到一个新文件夹后再安装；不要删除 data。'
                : ''),
          );
      }
    };
    visit(root);
  }
  return { root, releaseId: hash(fs.readFileSync(manifestFile)), manifest };
}
export function operationFile(file) {
  return path.join(path.dirname(file), 'operation.json');
}
export function parseOperation(value, file) {
  if (
    !value ||
    value.version !== 1 ||
    !uuid(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    ![
      'prepared',
      'stopping',
      'backup',
      'restoring',
      'starting',
      'verifying',
      'committed',
      'recovering',
      'recovery_required',
    ].includes(value.phase)
  )
    throw Error('Unknown maintenance record; original data preserved.');
  parseTarget(value.before);
  parseTarget(value.candidate);
  const root = path.dirname(file);
  for (const target of [value.backupDir, value.restoreDir])
    if (!absolute(target) || !inside(root, target))
      throw Error('Maintenance output is outside this installation.');
  return value;
}
function saveOperation(file, operation) {
  atomicJson(operationFile(file), operation);
}
function clearOperation(file, token) {
  const guard = operationFile(file);
  if (readJson(guard).token !== token) throw Error('Maintenance owner changed.');
  fs.unlinkSync(guard); // Only this manager's journal, never an engine instance.lock.
}
function saveResult(file, value) {
  const root = path.join(path.dirname(file), 'history');
  fs.mkdirSync(root, { recursive: true });
  atomicJson(path.join(root, value.token + '.json'), value);
}
export async function upgradeInstallation(file, directory, ops) {
  const state = parseInstallation(readJson(file));
  const pack = await ops.validate(directory);
  if (pack.releaseId === state.current.releaseId)
    return { state: 'unchanged', releaseId: pack.releaseId };
  await ops.ensure(state.current, state);
  const token = randomUUID(),
    folder = path.join(path.dirname(file), 'generations', token);
  const operation = {
    version: 1,
    token,
    pid: process.pid,
    phase: 'prepared',
    before: state.current,
    candidate: {
      releaseDir: pack.root,
      releaseId: pack.releaseId,
      configFile: path.join(folder, 'config.json'),
      generationId: randomUUID(),
    },
    backupDir: path.join(path.dirname(file), 'backups', token),
    restoreDir: folder,
    startedAt: new Date().toISOString(),
  };
  const fd = fs.openSync(operationFile(file), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(operation, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let candidateStarted = false,
    stopped = false;
  const checkpoint = (phase) => {
    operation.phase = phase;
    saveOperation(file, operation);
    ops.progress?.(phase);
  };
  try {
    const retained = await ops.inspect(state.current, state);
    checkpoint('stopping');
    await ops.stop(state.current, state);
    stopped = true;
    checkpoint('backup');
    await ops.backup(state.current, operation.backupDir, state);
    checkpoint('restoring');
    await ops.restore(operation, state);
    atomicJson(file, { ...state, current: operation.candidate, previous: state.current });
    checkpoint('starting');
    candidateStarted = true;
    await ops.ensure(operation.candidate, state, token);
    checkpoint('verifying');
    await ops.verify(operation.candidate, state, retained);
    checkpoint('committed');
    saveResult(file, { ...operation, outcome: 'updated', finishedAt: new Date().toISOString() });
    clearOperation(file, token);
    return { state: 'updated', releaseId: pack.releaseId, backup: operation.backupDir };
  } catch (error) {
    if (operation.phase === 'committed') throw error;
    try {
      if (candidateStarted) await ops.stop(operation.candidate, state);
      atomicJson(file, state);
      if (stopped) await ops.ensure(state.current, state, token);
      saveResult(file, {
        ...operation,
        outcome: 'rolled_back',
        reason: String(error?.message ?? error),
        finishedAt: new Date().toISOString(),
      });
      clearOperation(file, token);
    } catch (recovery) {
      operation.phase = 'recovery_required';
      operation.reason = String(error?.message ?? error);
      operation.recoveryReason = String(recovery?.message ?? recovery);
      saveOperation(file, operation);
      throw Error('升级未完成，恢复尚需确认。原目录和备份均保留；运行“恢复工作台”。');
    }
    throw Object.assign(
      Error('升级未完成，原版本入口已恢复：' + String(error?.message ?? error)),
      error?.code === 'UPGRADE_BUSY' ? { code: 'UPGRADE_BUSY' } : {},
    );
  }
}
export async function recoverInstallation(file, ops) {
  const record = operationFile(file);
  if (!fs.existsSync(record)) return { state: 'ready' };
  const old = parseOperation(readJson(record), file);
  try {
    process.kill(old.pid, 0);
    throw Error('维护进程仍在运行，请等待完成。');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const claim = path.join(path.dirname(file), 'recovery-claim.json'),
    token = randomUUID();
  if (fs.existsSync(claim)) {
    const previous = readJson(claim),
      serialized = fs.readFileSync(claim, 'utf8');
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || !uuid(previous.token))
      throw Error('Unknown recovery owner; original record preserved.');
    try {
      process.kill(previous.pid, 0);
      throw Error('恢复进程仍在运行。');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    if (fs.readFileSync(claim, 'utf8') !== serialized) throw Error('Recovery owner changed.');
    fs.unlinkSync(claim);
  }
  const fd = fs.openSync(claim, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
  fs.closeSync(fd);
  try {
    if (readJson(record).token !== old.token) throw Error('Maintenance changed.');
    const operation = { ...old, pid: process.pid, token };
    saveOperation(file, operation);
    const state = parseInstallation(readJson(file));
    if (old.phase === 'committed') {
      await ops.ensure(state.current, state, token);
    } else {
      if (state.current.generationId === old.candidate.generationId)
        await ops.stop(old.candidate, state);
      const recovered = { ...state, current: old.before };
      delete recovered.previous;
      atomicJson(file, recovered);
      await ops.ensure(old.before, recovered, token);
    }
    saveResult(file, { ...operation, outcome: 'recovered', finishedAt: new Date().toISOString() });
    clearOperation(file, token);
    return { state: 'recovered' };
  } finally {
    if (readJson(claim).token === token) fs.unlinkSync(claim);
  }
}
