import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { matchesNpmPlatform, npmOptionalPackages } from './agent-npm-lock.js';

it('shares OS, CPU and libc selection and rejects unknown libc instead of silently omitting native packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-lock-'));
  try {
    const entry = { version: '1.0.0', optional: true };
    const packages = {
      'node_modules/wrapper': entry,
      'node_modules/glibc': { ...entry, os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
      'node_modules/musl': { ...entry, os: ['linux'], cpu: ['x64'], libc: ['musl'] },
      'node_modules/windows': { ...entry, os: ['win32'] },
      'node_modules/dev': { ...entry, dev: true },
    };
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    expect(
      npmOptionalPackages(root, { os: 'linux', arch: 'x64', libc: 'glibc' }).map(([path]) => path),
    ).toEqual(['node_modules/glibc', 'node_modules/wrapper']);
    expect(
      npmOptionalPackages(root, { os: 'linux', arch: 'x64', libc: 'musl' }).map(([path]) => path),
    ).toEqual(['node_modules/musl', 'node_modules/wrapper']);
    expect(() => npmOptionalPackages(root, { os: 'linux', arch: 'x64' })).toThrow('libc');
    for (const path of [
      'node_modules/../outside',
      'node_modules/a/node_modules/..',
      'node_modules/a/extra',
    ]) {
      writeFileSync(
        join(root, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: { [path]: entry } }),
      );
      expect(() => npmOptionalPackages(root)).toThrow('包路径');
    }
    expect(matchesNpmPlatform(['any', '!win32'], 'win32')).toBe(false);
    expect(matchesNpmPlatform(['!win32'], 'linux')).toBe(true);
    expect(matchesNpmPlatform(['linux', '!linux'], 'linux')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
