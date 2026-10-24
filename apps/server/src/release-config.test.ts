import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { openSync, mkdirSync } from 'node:fs';
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), writeFileSync: vi.fn(fs.writeFileSync) };
});
import {
  ReleaseConfigSchema,
  readReleaseConfig,
  acquireInstanceLock,
  maintenanceMarker,
} from './release-config.js';

describe('release configuration and ownership', () => {
  it('anchors data to the config, validates strict config and only exposes loopback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-config-'));
    try {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({ version: 1, dataDir: '独立 数据' }));
      expect(readReleaseConfig(file)).toMatchObject({
        host: '127.0.0.1',
        port: 3000,
        dataDir: join(dir, '独立 数据'),
      });
      for (const invalid of [
        { version: 1, port: '3000' },
        { version: 1, port: 0 },
        { version: 1, host: '0.0.0.0' },
        { version: 1, dataDir: '' },
        { version: 2 },
      ])
        expect(ReleaseConfigSchema.safeParse(invalid).success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('excludes a second writer, releases only its own lock, and fails closed after stale ownership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-lock-'));
    try {
      const release = acquireInstanceLock(dir);
      expect(() => acquireInstanceLock(dir)).toThrow('Data directory is locked');
      release();
      expect(existsSync(join(dir, 'instance.lock'))).toBe(false);
      const releaseAgain = acquireInstanceLock(dir);
      releaseAgain();
      writeFileSync(join(dir, 'instance.lock'), JSON.stringify({ pid: 99999999, token: 'stale' }));
      expect(() => acquireInstanceLock(dir)).toThrow('not removed automatically');
      release();
      expect(existsSync(join(dir, 'instance.lock'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

for (const location of ['data', 'config'] as const)
  it(`rechecks ${location} maintenance marker after lock acquisition and releases its own lock on failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-marker-race-'));
    const data = join(root, 'data');
    mkdirSync(data);
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({ version: 1, dataDir: './data' }));
    const parsed = readReleaseConfig(file); // Marker appears only after the first configuration check.
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    let inserted = false;
    let cleanup: (() => void) | undefined;
    vi.mocked(openSync).mockImplementation(((...args: Parameters<typeof openSync>) => {
      const fd = real.openSync(...args);
      if (String(args[0]) === join(data, 'instance.lock')) {
        writeFileSync(
          join(location === 'data' ? data : root, maintenanceMarker),
          'maintenance in progress',
        );
        inserted = true;
      }
      return fd;
    }) as typeof openSync);
    try {
      expect(() => {
        cleanup = acquireInstanceLock(parsed.dataDir, file);
      }).toThrow('not runnable');
      expect(inserted).toBe(true);
      expect(existsSync(join(data, 'instance.lock'))).toBe(false);
      expect(existsSync(join(data, 'control-plane.sqlite'))).toBe(false);
    } finally {
      cleanup?.();
      vi.mocked(openSync).mockImplementation(real.openSync);
      rmSync(root, { recursive: true, force: true });
    }
  });

it('removes only its own uninitialized lock after a write failure and allows retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-lock-init-failure-'));
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  try {
    writeFileSync(join(dir, 'sentinel'), 'keep');
    vi.mocked(writeFileSync).mockImplementation(((...args: Parameters<typeof writeFileSync>) => {
      if (typeof args[0] === 'number')
        throw Object.assign(new Error('Injected ENOSPC'), { code: 'ENOSPC' });
      return real.writeFileSync(...args);
    }) as typeof writeFileSync);
    expect(() => acquireInstanceLock(dir)).toThrow('Injected ENOSPC');
    expect(existsSync(join(dir, 'instance.lock'))).toBe(false);
    expect(real.readFileSync(join(dir, 'sentinel'), 'utf8')).toBe('keep');
    vi.mocked(writeFileSync).mockImplementation(real.writeFileSync);
    acquireInstanceLock(dir)();
    expect(existsSync(join(dir, 'instance.lock'))).toBe(false);
  } finally {
    vi.mocked(writeFileSync).mockImplementation(real.writeFileSync);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preserves a replacement lock if initialization fails after path ownership changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-lock-init-replaced-'));
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  const lock = join(dir, 'instance.lock');
  try {
    vi.mocked(writeFileSync).mockImplementation(((...args: Parameters<typeof writeFileSync>) => {
      if (typeof args[0] === 'number') {
        real.renameSync(lock, join(dir, 'original-owned-lock'));
        real.writeFileSync(lock, 'foreign-replacement');
        throw new Error('Injected initialization failure');
      }
      return real.writeFileSync(...args);
    }) as typeof writeFileSync);
    expect(() => acquireInstanceLock(dir)).toThrow('Injected initialization failure');
    expect(real.readFileSync(lock, 'utf8')).toBe('foreign-replacement');
  } finally {
    vi.mocked(writeFileSync).mockImplementation(real.writeFileSync);
    rmSync(dir, { recursive: true, force: true });
  }
});
