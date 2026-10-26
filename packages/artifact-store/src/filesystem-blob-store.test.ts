import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import * as io from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemArtifactBlobStore } from './filesystem-blob-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
  };
});
const realIo = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atomic-blob-'));
  directories.push(root);
  const content = new TextEncoder().encode('immutable result');
  const hash = createHash('sha256').update(content).digest('hex');
  const target = join(root, 'sha256', hash.slice(0, 2), hash);
  return { root, content, target, store: new FilesystemArtifactBlobStore(root) };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.mocked(io.open).mockReset().mockImplementation(realIo.open);
  vi.mocked(io.link).mockReset().mockImplementation(realIo.link);
  vi.mocked(io.unlink).mockReset().mockImplementation(realIo.unlink);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('atomic filesystem blob publication', () => {
  it('publishes concurrent identical content without exposing an unfinished writer', async () => {
    const f = fixture();
    const writing = gate(),
      release = gate();
    vi.mocked(io.open).mockImplementationOnce(async (...args) => {
      const handle = await realIo.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...writeArgs) => {
        writing.resolve();
        await release.promise;
        return write(...writeArgs);
      });
      return handle;
    });
    const first = f.store.put(f.content);
    await writing.promise;
    const second = await f.store.put(f.content).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    release.resolve();
    const firstResult = await first;
    expect(second).not.toHaveProperty('error');
    expect('value' in second && second.value.storageKey).toBe(firstResult.storageKey);
    expect(
      'value' in second && [second.value.deduplicated, firstResult.deduplicated].sort(),
    ).toEqual([false, true]);
    expect(new Uint8Array(await realIo.readFile(f.target))).toEqual(f.content);
    expect(
      (await realIo.readdir(dirname(f.target))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('retries after an interrupted write even when abandoned temporary bytes could not be cleaned', async () => {
    const f = fixture();
    vi.mocked(io.open).mockImplementationOnce(async (...args) => {
      const handle = await realIo.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await write(f.content.subarray(0, 1));
        throw new Error('Injected interrupted write');
      });
      return handle;
    });
    // Model loss of cleanup after interruption, without killing a process. The
    // incomplete file must remain private and cannot poison the final address.
    vi.mocked(io.unlink).mockRejectedValueOnce(new Error('Cleanup unavailable'));
    await expect(f.store.put(f.content)).rejects.toThrow('Injected interrupted write');
    await expect(realIo.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await realIo.readdir(dirname(f.target))).every((name) => name.endsWith('.tmp'))).toBe(
      true,
    );
    const result = await f.store.put(f.content);
    expect(result.deduplicated).toBe(false);
    expect(new Uint8Array(await f.store.read(result.storageKey))).toEqual(f.content);
  });

  it('cleans its own staging file after an installation failure and permits retry', async () => {
    const f = fixture();
    vi.mocked(io.link).mockRejectedValueOnce(
      Object.assign(new Error('Injected install failure'), { code: 'EPERM' }),
    );
    await expect(f.store.put(f.content)).rejects.toThrow('Injected install failure');
    expect(await realIo.readdir(dirname(f.target))).toEqual([]);
    const result = await f.store.put(f.content);
    expect(new Uint8Array(await f.store.read(result.storageKey))).toEqual(f.content);
  });

  it('reuses a fully installed blob after interruption of temporary-file cleanup', async () => {
    const f = fixture();
    vi.mocked(io.unlink).mockRejectedValueOnce(new Error('Cleanup unavailable'));
    const installed = await f.store.put(f.content);
    const retried = await f.store.put(f.content);
    expect(retried).toMatchObject({ storageKey: installed.storageKey, deduplicated: true });
    expect(new Uint8Array(await f.store.read(retried.storageKey))).toEqual(f.content);
  });

  it('preserves an existing corrupt address rather than overwriting it', async () => {
    const f = fixture();
    await realIo.mkdir(dirname(f.target), { recursive: true });
    await realIo.writeFile(f.target, 'corrupt');
    await expect(f.store.put(f.content)).rejects.toMatchObject({ code: 'BLOB_INTEGRITY' });
    expect(await realIo.readFile(f.target, 'utf8')).toBe('corrupt');
    expect(await realIo.readdir(dirname(f.target))).toEqual([f.target.split(/[\\/]/).at(-1)]);
  });
});
