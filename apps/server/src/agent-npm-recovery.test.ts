import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { restoreNpmOptionalPackages } from './agent-npm-recovery.js';
import { npmRuntime } from './agent-package-install.js';
import type { NetworkSettingsService } from './network-settings.js';

it('restores locked host native and JS optional dependencies, replacing incomplete packages atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-recovery-'));
  try {
    const npmCli = npmRuntime(root)!;
    const tar = createRequire(npmCli)('tar');
    const source = join(root, 'source');
    mkdirSync(join(source, 'package'), { recursive: true });
    writeFileSync(
      join(source, 'package/package.json'),
      JSON.stringify({ name: 'fixture', version: '1.2.3', bin: { fixture: 'native.exe' } }),
    );
    writeFileSync(join(source, 'package/native.exe'), 'complete inert native fixture');
    const archive = join(root, 'fixture.tgz');
    await tar.c({ cwd: source, gzip: true, file: archive }, ['package']);
    const bytes = readFileSync(archive);
    const record = {
      version: '1.2.3',
      optional: true,
      resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz',
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    };
    const packages = {
      'node_modules/native': { ...record, os: [process.platform], cpu: [process.arch] },
      'node_modules/js-wrapper': record,
      'node_modules/foreign': { ...record, os: ['!' + process.platform] },
    };
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    mkdirSync(join(root, 'node_modules/native'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules/native/package.json'),
      JSON.stringify({ version: '0.0.0' }),
    );
    const fetch = vi.fn(async () => new Response(bytes));
    const options = {
      directory: root,
      npmCli,
      network: { fetch } as unknown as NetworkSettingsService,
      phase: vi.fn(),
    };
    await restoreNpmOptionalPackages(options);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Matching versions cannot hide missing or same-size corrupted native files.
    writeFileSync(
      join(root, 'node_modules/native/native.exe'),
      'x'.repeat('complete inert native fixture'.length),
    );
    rmSync(join(root, 'node_modules/js-wrapper/native.exe'));
    await restoreNpmOptionalPackages(options);
    expect(fetch).toHaveBeenCalledTimes(2); // Reuse only checksum-verified cached archives.
    expect(readFileSync(join(root, 'node_modules/native/native.exe'), 'utf8')).toContain(
      'complete inert',
    );
    expect(readFileSync(join(root, 'node_modules/js-wrapper/native.exe'), 'utf8')).toContain(
      'complete inert',
    );
    for (const name of ['native', 'js-wrapper'])
      expect(readFileSync(join(root, 'node_modules', name, 'native.exe'), 'utf8')).toContain(
        'complete inert',
      );
    expect(existsSync(join(root, 'node_modules/foreign'))).toBe(false);
    expect(
      existsSync(
        join(root, 'node_modules/.bin', process.platform === 'win32' ? 'fixture.cmd' : 'fixture'),
      ),
    ).toBe(true);
    await restoreNpmOptionalPackages(options);
    expect(fetch).toHaveBeenCalledTimes(2);
    // A mismatched digest is never promoted into node_modules.
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/rejected': {
            ...record,
            integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
          },
        },
      }),
    );
    await expect(restoreNpmOptionalPackages(options)).rejects.toThrow('校验失败');
    expect(existsSync(join(root, 'node_modules/rejected'))).toBe(false);
    // Recovery cannot substitute an arbitrary registry URL.
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/rejected': { ...record, resolved: 'https://untrusted.example/package.tgz' },
        },
      }),
    );
    const requests = fetch.mock.calls.length;
    await expect(restoreNpmOptionalPackages(options)).rejects.toThrow('官方包信息');
    expect(fetch).toHaveBeenCalledTimes(requests);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
