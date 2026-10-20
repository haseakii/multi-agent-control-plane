import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ArtifactBlobStore, BlobWriteResult } from './types.js';
import { ArtifactStoreError } from './types.js';

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function bytesEqualHash(content: Uint8Array, expected: string): boolean {
  return sha256(content) === expected;
}

export class FilesystemArtifactBlobStore implements ArtifactBlobStore {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async put(content: Uint8Array): Promise<BlobWriteResult> {
    const digest = sha256(content);
    const storageKey = `sha256/${digest.slice(0, 2)}/${digest}`;
    const target = this.resolveStorageKey(storageKey);
    await mkdir(dirname(target), { recursive: true });

    let handle;
    try {
      handle = await open(target, 'wx');
      await handle.writeFile(content);
      await handle.sync();
      return {
        sha256: digest,
        sizeBytes: content.byteLength,
        storageKey,
        deduplicated: false,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if (handle) {
          await handle.close().catch(() => undefined);
          await unlink(target).catch(() => undefined);
        }
        throw error;
      }

      const existing = new Uint8Array(await readFile(target));
      if (existing.byteLength !== content.byteLength || !bytesEqualHash(existing, digest)) {
        throw new ArtifactStoreError(
          'BLOB_INTEGRITY',
          `Existing artifact blob does not match its content address: ${storageKey}`,
        );
      }
      return {
        sha256: digest,
        sizeBytes: content.byteLength,
        storageKey,
        deduplicated: true,
      };
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  async read(storageKey: string): Promise<Uint8Array> {
    const target = this.resolveStorageKey(storageKey);
    let content: Uint8Array;
    try {
      content = new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactStoreError('BLOB_NOT_FOUND', `Artifact blob not found: ${storageKey}`);
      }
      throw error;
    }

    const expected = storageKey.split('/').at(-1);
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !bytesEqualHash(content, expected)) {
      throw new ArtifactStoreError(
        'BLOB_INTEGRITY',
        `Artifact blob failed content-address verification: ${storageKey}`,
      );
    }
    return content;
  }

  private resolveStorageKey(storageKey: string): string {
    if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(storageKey)) {
      throw new ArtifactStoreError('INVALID_STORAGE_KEY', `Invalid artifact storage key: ${storageKey}`);
    }
    const resolved = resolve(this.rootPath, storageKey);
    if (resolved !== this.rootPath && !resolved.startsWith(`${this.rootPath}${sep}`)) {
      throw new ArtifactStoreError('INVALID_STORAGE_KEY', 'Artifact storage key escapes root path.');
    }
    return resolved;
  }
}
