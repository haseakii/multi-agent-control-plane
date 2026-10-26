import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  matchesPackageInventory,
  packageFilePath,
  packageInventory,
  promotePackage,
} from './agent-package-files.js';
import { prepareNativeRuntime } from './agent-native-runtime.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acp-package-files-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('detects missing or changed same-size files even when the manifest version is unchanged', async () => {
  const root = fixture();
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
  writeFileSync(join(root, 'native.exe'), 'complete');
  const inventory = await packageInventory(root);
  expect(await matchesPackageInventory(root, inventory)).toBe(true);
  writeFileSync(join(root, 'native.exe'), 'corrupt!');
  expect(await matchesPackageInventory(root, inventory)).toBe(false);
  rmSync(join(root, 'native.exe'));
  expect(await matchesPackageInventory(root, inventory)).toBe(false);
});

it('rolls back an existing package if finalization or cancellation fails', async () => {
  const root = fixture(),
    target = join(root, 'target'),
    staging = join(root, 'staging');
  mkdirSync(target);
  mkdirSync(staging);
  writeFileSync(join(target, 'native.exe'), 'old');
  writeFileSync(join(staging, 'native.exe'), 'new');
  await expect(
    promotePackage(root, staging, target, async () => {
      expect(readFileSync(join(target, 'native.exe'), 'utf8')).toBe('new');
      throw new Error('entry linking failed');
    }),
  ).rejects.toThrow('entry linking failed');
  expect(readFileSync(join(target, 'native.exe'), 'utf8')).toBe('old');
  mkdirSync(staging);
  writeFileSync(join(staging, 'native.exe'), 'new');
  const abort = new AbortController();
  await expect(
    promotePackage(root, staging, target, async () => {
      abort.abort();
      abort.signal.throwIfAborted();
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(target, 'native.exe'), 'utf8')).toBe('old');
});

it('rejects junction ancestors and leaves the other directory untouched', () => {
  const root = fixture(),
    outside = fixture();
  symlinkSync(outside, join(root, 'linked'), 'junction');
  expect(() => packageFilePath(root, 'linked/program/file')).toThrow('链接');
  expect(existsSync(join(outside, 'program'))).toBe(false);
});

it('copies when hard links are unsupported, reuses complete mirrors, and rebuilds damaged mirrors', async () => {
  const root = fixture(),
    source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'native.exe'), 'complete');
  vi.mocked(linkSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('unsupported'), { code: 'EXDEV' });
  });
  const target = await prepareNativeRuntime(root, source, 'runtime');
  expect(readFileSync(join(target, 'native.exe'), 'utf8')).toBe('complete');
  const links = vi.mocked(linkSync).mock.calls.length;
  expect(await prepareNativeRuntime(root, source, 'runtime')).toBe(target);
  expect(linkSync).toHaveBeenCalledTimes(links);
  writeFileSync(join(target, 'native.exe'), 'corrupt!');
  await prepareNativeRuntime(root, source, 'runtime');
  expect(readFileSync(join(target, 'native.exe'), 'utf8')).toBe('complete');
  await expect(prepareNativeRuntime(root, source, 'source/nested')).rejects.toThrow('重叠');
});
