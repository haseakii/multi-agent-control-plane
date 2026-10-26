import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import {
  atomicJson,
  readJson,
  upgradeInstallation,
  recoverInstallation,
  operationFile,
  parseInstallation,
} from '../lib/installation.mjs';
it('copies a release from Unicode directories without aborting the Windows process', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'release-copy-'));
  try {
    const source = path.join(root, '中文 发行包');
    const target = path.join(root, '新机器 用户', 'version');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    const bytes = Buffer.from('original release bytes');
    fs.writeFileSync(path.join(source, 'nested', 'proof.txt'), bytes);
    const code = `import {copyReleaseDirectory} from ${JSON.stringify(new URL('../lib/installation.mjs', import.meta.url).href)}; copyReleaseDirectory(process.argv[1],process.argv[2]);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, source, target], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    expect(child.status, child.stderr || child.error?.message).toBe(0);
    expect(fs.readFileSync(path.join(target, 'nested', 'proof.txt'))).toEqual(bytes);
    expect(fs.readFileSync(path.join(source, 'nested', 'proof.txt'))).toEqual(bytes);
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'release-copy-'))
      throw Error('Unexpected release copy fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'installation-flow-')),
    file = path.join(root, 'installation.json');
  const before = {
    releaseDir: path.join(root, 'versions/old'),
    releaseId: 'a'.repeat(64),
    configFile: path.join(root, 'old/config.json'),
    generationId: randomUUID(),
  };
  const state = {
    version: 1,
    id: randomUUID(),
    runtimeFile: path.join(root, 'runtime/node.exe'),
    current: before,
    environment: {},
  };
  atomicJson(file, state);
  const ops = {
    validate: vi.fn(async () => ({
      root: path.join(root, 'versions/new'),
      releaseId: 'b'.repeat(64),
    })),
    ensure: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ kept: 'original inputs, permissions and unmerged changes' })),
    stop: vi.fn(async () => {}),
    backup: vi.fn(async (_, dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'proof'), 'original bytes');
    }),
    restore: vi.fn(async (operation) => {
      fs.mkdirSync(operation.restoreDir, { recursive: true });
      atomicJson(operation.candidate.configFile, { version: 1, dataDir: './data' });
    }),
    verify: vi.fn(async () => {}),
  };
  return {
    root,
    file,
    state,
    ops,
    cleanup: () => {
      if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'installation-flow-'))
        throw Error('Unexpected fixture path');
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
it('commits one current pointer only after backup, separate restoration and readiness verification', async () => {
  const f = fixture();
  try {
    const result = await upgradeInstallation(f.file, 'new', f.ops);
    expect(result.state).toBe('updated');
    const after = readJson(f.file);
    expect(after.current.releaseId).toBe('b'.repeat(64));
    expect(after.previous).toEqual(f.state.current);
    expect(after.current.configFile).not.toBe(f.state.current.configFile);
    expect(fs.readFileSync(path.join(result.backup, 'proof'), 'utf8')).toBe('original bytes');
    expect(fs.existsSync(operationFile(f.file))).toBe(false);
    expect(f.ops.verify).toHaveBeenCalledWith(after.current, f.state, {
      kept: 'original inputs, permissions and unmerged changes',
    });
  } finally {
    f.cleanup();
  }
});
it('refuses active work before stopping the original instance', async () => {
  const f = fixture();
  try {
    f.ops.inspect.mockRejectedValue(Error('active work'));
    await expect(upgradeInstallation(f.file, 'new', f.ops)).rejects.toThrow('active work');
    expect(f.ops.stop).not.toHaveBeenCalled();
    expect(f.ops.backup).not.toHaveBeenCalled();
    expect(readJson(f.file)).toEqual(f.state);
  } finally {
    f.cleanup();
  }
});
it.each(['backup', 'restore', 'verify'])(
  'restores the original pointer after a %s failure and retains recovery evidence',
  async (phase) => {
    const f = fixture();
    try {
      f.ops[phase].mockRejectedValue(Error('injected ' + phase));
      await expect(upgradeInstallation(f.file, 'new', f.ops)).rejects.toThrow('原版本入口已恢复');
      expect(readJson(f.file)).toEqual(f.state);
      expect(fs.existsSync(operationFile(f.file))).toBe(false);
      expect(f.ops.ensure.mock.calls.at(-1)[0]).toEqual(f.state.current);
      if (phase === 'verify')
        expect(f.ops.stop.mock.calls.at(-1)[0].releaseId).toBe('b'.repeat(64));
      expect(fs.readdirSync(path.join(f.root, 'history'))).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
);
it('retains a failed recovery, then explicitly recovers an interrupted maintenance owner without touching data locks', async () => {
  const f = fixture();
  try {
    f.ops.verify.mockRejectedValue(Error('bad candidate'));
    f.ops.stop.mockImplementation(async (target) => {
      if (target.releaseId.startsWith('b')) throw Error('cannot confirm stop');
    });
    await expect(upgradeInstallation(f.file, 'new', f.ops)).rejects.toThrow('恢复尚需确认');
    const journal = readJson(operationFile(f.file));
    expect(journal.phase).toBe('recovery_required');
    await expect(recoverInstallation(f.file, f.ops)).rejects.toThrow('维护进程仍在运行');
    journal.pid = 99999999;
    atomicJson(operationFile(f.file), journal);
    f.ops.stop.mockResolvedValue();
    await expect(recoverInstallation(f.file, f.ops)).resolves.toEqual({ state: 'recovered' });
    expect(readJson(f.file).current).toEqual(f.state.current);
    expect(fs.existsSync(operationFile(f.file))).toBe(false);
  } finally {
    f.cleanup();
  }
});
it('finishes an interrupted verified commit instead of reverting to stale task data', async () => {
  const f = fixture();
  try {
    await upgradeInstallation(f.file, 'new', f.ops);
    const current = readJson(f.file);
    atomicJson(operationFile(f.file), {
      version: 1,
      token: randomUUID(),
      pid: 99999999,
      phase: 'committed',
      before: f.state.current,
      candidate: current.current,
      backupDir: path.join(f.root, 'backups/recovery'),
      restoreDir: path.dirname(current.current.configFile),
    });
    await recoverInstallation(f.file, f.ops);
    expect(readJson(f.file).current).toEqual(current.current);
    expect(f.ops.ensure.mock.calls.at(-1)[0]).toEqual(current.current);
  } finally {
    f.cleanup();
  }
});
it('rejects unknown installation versions and preserves existing records', () => {
  const f = fixture();
  try {
    expect(() => parseInstallation({ ...f.state, version: 2 })).toThrow('Unsupported');
    expect(readJson(f.file)).toEqual(f.state);
  } finally {
    f.cleanup();
  }
});

it('defers an upgrade while work is active without stopping or replacing the current installation', async () => {
  const f = fixture();
  try {
    f.ops.inspect.mockRejectedValue(Object.assign(Error('active task'), { code: 'UPGRADE_BUSY' }));
    await expect(upgradeInstallation(f.file, 'new', f.ops)).rejects.toMatchObject({
      code: 'UPGRADE_BUSY',
    });
    expect(f.ops.stop).not.toHaveBeenCalled();
    expect(f.ops.backup).not.toHaveBeenCalled();
    expect(readJson(f.file)).toEqual(f.state);
    expect(fs.existsSync(operationFile(f.file))).toBe(false);
  } finally {
    f.cleanup();
  }
});
