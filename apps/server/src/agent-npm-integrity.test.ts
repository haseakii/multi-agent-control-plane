import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyNpmPlatformPackages } from './agent-npm-integrity.js';
import { installAgentPackage, packagePlan } from './agent-package-install.js';
import type { NetworkSettingsService } from './network-settings.js';

const directories: string[] = [];
function fixture(packages: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'acp-npm-integrity-'));
  directories.push(root);
  const directory = join(root, 'installed');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return { root, directory };
}
function manifest(directory: string, version: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'aliased', version }));
}
const hostPackage = { version: '2.0.0-win32-x64', optional: true, os: ['win32'], cpu: ['x64'] };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('refuses a missing native package instead of accepting one from an ancestor install', () => {
  const { root, directory } = fixture({ 'node_modules/@fixture/native': hostPackage });
  manifest(join(root, 'node_modules/@fixture/native'), '1.0.0');
  expect(() => verifyNpmPlatformPackages(directory, 'win32', 'x64')).toThrow('依赖安装不完整');
});

it.each(['missing-manifest', 'wrong-version'])('refuses a partial platform install: %s', (kind) => {
  const { directory } = fixture({ 'node_modules/@fixture/native': hostPackage });
  const pkg = join(directory, 'node_modules/@fixture/native');
  mkdirSync(pkg, { recursive: true });
  if (kind === 'wrong-version') manifest(pkg, '1.0.0');
  else writeFileSync(join(pkg, 'partial.exe'), 'incomplete extraction');
  expect(() => verifyNpmPlatformPackages(directory, 'win32', 'x64')).toThrow('依赖安装不完整');
});

it('accepts local npm aliases and skips optional packages for other platforms or CPUs', () => {
  const { directory } = fixture({
    'node_modules/@fixture/native': hostPackage,
    'node_modules/@fixture/linux': { ...hostPackage, os: ['linux'] },
    'node_modules/@fixture/arm64': { ...hostPackage, cpu: ['arm64'] },
    'node_modules/@fixture/not-windows': { ...hostPackage, os: ['!win32'] },
    'node_modules/@fixture/development': { ...hostPackage, dev: true },
  });
  manifest(join(directory, 'node_modules/@fixture/native'), hostPackage.version);
  expect(() => verifyNpmPlatformPackages(directory, 'win32', 'x64')).not.toThrow();
});

it('refuses platform package paths outside the selected install directory', () => {
  const { directory } = fixture({ 'node_modules/../../outside': hostPackage });
  expect(() => verifyNpmPlatformPackages(directory, 'win32', 'x64')).toThrow('依赖安装不完整');
});

it('refuses platform manifests linked to another installation', () => {
  const { root, directory } = fixture({ 'node_modules/@fixture/native': hostPackage });
  const outside = join(root, 'outside');
  manifest(outside, hostPackage.version);
  mkdirSync(join(directory, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(outside, join(directory, 'node_modules/@fixture/native'), 'junction');
  expect(() => verifyNpmPlatformPackages(directory, 'win32', 'x64')).toThrow('依赖安装不完整');
});

it('requires npm to finish writing its installation lockfile', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-npm-integrity-'));
  directories.push(root);
  expect(() => verifyNpmPlatformPackages(root, 'win32', 'x64')).toThrow('依赖安装不完整');
});

it('rejects an npm success result with a missing host dependency before returning an ACP entry', async () => {
  const { root, directory } = fixture({
    'node_modules/@fixture/native': {
      ...hostPackage,
      os: [process.platform],
      cpu: [process.arch],
    },
  });
  mkdirSync(join(root, 'runtime/npm/bin'), { recursive: true });
  writeFileSync(join(root, 'runtime/npm/bin/npm-cli.js'), 'not executed');
  const pkg = join(directory, 'node_modules/@fixture/acp');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@fixture/acp', version: '1.0.0', bin: 'main.js' }),
  );
  writeFileSync(join(pkg, 'main.js'), 'throw new Error("must not execute");');
  const plan = packagePlan(
    {
      id: 'fixture',
      name: 'Fixture',
      version: '1.0.0',
      description: 'Inert fixture',
      license_url: 'https://example.com/LICENSE',
      distribution: { npx: { package: '@fixture/acp@1.0.0' } },
    },
    'windows-x86_64',
    true,
  );
  await expect(
    installAgentPackage({
      plan,
      directory,
      releaseRoot: root,
      network: { effective: () => ({ mode: 'unmanaged' }) } as unknown as NetworkSettingsService,
      phase: () => undefined,
      run: async () => undefined,
    }),
  ).rejects.toThrow('依赖安装不完整');
});
