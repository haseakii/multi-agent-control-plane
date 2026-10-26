import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { lockFileIdentity, windowsInstanceLockRemover } from './instance-lock-remover.js';
const dirs: string[] = [];
afterEach(() => {
  vi.mocked(execFileSync).mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function own() {
  const directory = mkdtempSync(join(tmpdir(), 'cp-native-lock-'));
  dirs.push(directory);
  const filename = join(directory, 'instance.lock'),
    token = randomUUID();
  const fd = openSync(filename, 'wx');
  writeFileSync(fd, JSON.stringify({ token }));
  const identity = lockFileIdentity(fd);
  closeSync(fd);
  return { directory, filename, token, identity };
}
it.runIf(process.platform === 'win32')(
  'uses the actual Windows NTFS handle to remove the owned file',
  () => {
    const f = own();
    expect(windowsInstanceLockRemover.remove(f.filename, f.identity, f.token)).toEqual({
      removed: true,
      reason: 'removed',
    });
    expect(existsSync(f.filename)).toBe(false);
  },
  45000,
);

it.runIf(process.platform === 'win32')(
  'recovers only a dead owner and retains a live process lock',
  () => {
    const f = own();
    expect(
      windowsInstanceLockRemover.recover!(f.filename, f.identity, f.token, process.pid).removed,
    ).toBe(false);
    expect(existsSync(f.filename)).toBe(true);
    // Windows PIDs are bounded to a multiple of four; this absent PID cannot be a live owner.
    expect(
      windowsInstanceLockRemover.recover!(f.filename, f.identity, f.token, 2147483647).removed,
    ).toBe(true);
    expect(existsSync(f.filename)).toBe(false);
  },
  65000,
);

it.runIf(process.platform === 'win32')(
  'preserves a replacement present before the handle is opened',
  () => {
    const f = own();
    renameSync(f.filename, join(f.directory, 'original'));
    writeFileSync(f.filename, 'foreign');
    expect(windowsInstanceLockRemover.remove(f.filename, f.identity, f.token)).toEqual({
      removed: false,
      reason: 'owner_changed',
    });
    expect(readFileSync(f.filename, 'utf8')).toBe('foreign');
  },
  45000,
);

it.runIf(process.platform === 'win32')(
  'preserves a real replacement made after native identity verification, before deletion',
  () => {
    const f = own();
    const original = join(f.directory, 'moved-original');
    const native = readFileSync(new URL('./windows-lock-delete.cs', import.meta.url), 'utf8');
    const script = [
      "$ErrorActionPreference='Stop'",
      '$r=$env:CP_TEST_REQUEST | ConvertFrom-Json',
      'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CP_TEST_NATIVE)))',
      '$after = [Action]{ [IO.File]::Move([string]$r.path,[string]$r.original); [IO.File]::WriteAllText([string]$r.path,"foreign-after-native-check") }',
      '[ControlPlaneLockDelete]::Remove([string]$r.path,[UInt64]::Parse([string]$r.volumeId),[UInt64]::Parse([string]$r.fileId),[string]$r.token,$after) | ConvertTo-Json -Compress',
    ].join(String.fromCharCode(10));
    const output = execFileSync(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
          TEMP: tmpdir(),
          TMP: tmpdir(),
          CP_TEST_REQUEST: JSON.stringify({
            path: f.filename,
            original,
            token: f.token,
            ...f.identity,
          }),
          CP_TEST_NATIVE: Buffer.from(native).toString('base64'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(JSON.parse(output)).toEqual({ removed: true, reason: 'removed' });
    expect(readFileSync(f.filename, 'utf8')).toBe('foreign-after-native-check');
    expect(existsSync(original)).toBe(false);
  },
  45000,
);

it('retains the lock when the native primitive cannot run, with no pathname deletion fallback', () => {
  const f = own();
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error('Native primitive unavailable');
  });
  expect(windowsInstanceLockRemover.remove(f.filename, f.identity, f.token)).toEqual({
    removed: false,
    reason: 'unavailable',
  });
  expect(readFileSync(f.filename, 'utf8')).toBe(JSON.stringify({ token: f.token }));
});

it.runIf(process.platform === 'win32')(
  'removes an owned empty lock after initialization fails before a token was written',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'cp-native-empty-lock-'));
    dirs.push(directory);
    const filename = join(directory, 'instance.lock');
    const fd = openSync(filename, 'wx');
    const identity = lockFileIdentity(fd);
    closeSync(fd);
    expect(windowsInstanceLockRemover.remove(filename, identity)).toEqual({
      removed: true,
      reason: 'removed',
    });
    expect(existsSync(filename)).toBe(false);
  },
  45000,
);

it.runIf(process.platform !== 'win32')('fails closed on unsupported native platforms', () => {
  const f = own();
  expect(windowsInstanceLockRemover.remove(f.filename, f.identity, f.token)).toEqual({
    removed: false,
    reason: 'unavailable',
  });
  expect(existsSync(f.filename)).toBe(true);
  expect(execFileSync).not.toHaveBeenCalled();
});
