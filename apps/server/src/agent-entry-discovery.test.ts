import { expect, it, vi } from 'vitest';
import { discoverAgentEntries } from './agent-entry-discovery.js';
import type { CatalogEntry } from './agent-catalog.js';
import type { RegisteredAgentView } from './agent-control.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry: CatalogEntry = {
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: 'test',
  distribution: {
    binary: {
      'windows-x86_64': {
        archive: 'https://example.com/a.zip',
        cmd: './sample.exe',
        args: ['--from-registry'],
        env: { TOKEN: 'not-imported' },
      },
    },
  },
};
it('finds existing registrations and PATH files without executing or importing registry settings', () => {
  const agent = {
    definition: {
      id: 'existing',
      name: 'My instance',
      runtime: {
        type: 'acp-stdio',
        command: 'D:\\Installed\\sample.exe',
        args: ['--chosen-profile'],
      },
    },
  } as RegisteredAgentView;
  const isFile = vi.fn((path: string) => path === 'C:\\Tools\\sample.exe');
  const result = discoverAgentEntries(entry, 'windows-x86_64', [agent], {
    platform: 'win32',
    path: 'C:\\Tools;C:\\Tools;.;\\\\server\\share',
    isFile,
    environment: {},
  });
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0]?.agentId).toBe('existing');
  expect(result.candidates[0]?.runtime.args).toEqual(['--chosen-profile']);
  expect(result.candidates[1]?.runtime).toEqual({
    type: 'acp-stdio',
    command: 'C:\\Tools\\sample.exe',
    args: [],
  });
  expect(isFile).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('not-imported');
});
it('does not treat traversal or launcher names as product entrypoints', () => {
  const isFile = vi.fn(() => true);
  for (const cmd of ['../sample.exe', 'C:/outside.exe', './cmd.exe', './node.exe', 'script.cmd']) {
    const result = discoverAgentEntries(
      {
        ...entry,
        distribution: {
          binary: { 'windows-x86_64': { archive: 'https://example.com/a.zip', cmd } },
        },
      },
      'windows-x86_64',
      [],
      { platform: 'win32', path: 'C:\\Tools', isFile, environment: {} },
    );
    expect(result.candidates).toEqual([]);
  }
  expect(isFile).not.toHaveBeenCalled();
});
it('finds package subdirectory binaries and current user npm prefixes without scanning the home tree', () => {
  const nested = {
    ...entry,
    distribution: {
      binary: {
        'windows-x86_64': {
          archive: 'https://example.com/a.zip',
          cmd: './dist-package/bin/sample.exe',
        },
      },
    },
  };
  const isFile = vi.fn(
    (path: string) =>
      path === 'D:\\解压目录\\dist-package\\bin\\sample.exe' ||
      path === 'C:\\Users\\new-user\\AppData\\Roaming\\npm\\sample.exe',
  );
  const result = discoverAgentEntries(nested, 'windows-x86_64', [], {
    platform: 'win32',
    path: '',
    directory: 'D:\\解压目录',
    isFile,
    environment: { APPDATA: 'C:\\Users\\new-user\\AppData\\Roaming' },
  });
  expect(result.candidates.map((candidate) => candidate.runtime.command)).toEqual([
    'D:\\解压目录\\dist-package\\bin\\sample.exe',
    'C:\\Users\\new-user\\AppData\\Roaming\\npm\\sample.exe',
  ]);
  expect(result.candidates.map((candidate) => candidate.source)).toEqual(['directory', 'path']);
});

it.each(['dist/index.js', 'dist/adapter'])(
  'discovers the installed Node entry %s without executing it',
  (entrypoint) => {
    const root = mkdtempSync(join(tmpdir(), 'acp-installed-'));
    try {
      const packageRoot = join(root, 'node_modules', '@example', 'adapter');
      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      const script = join(packageRoot, entrypoint);
      const marker = join(root, 'executed');
      writeFileSync(
        script,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`,
      );
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@example/adapter',
          version: '2.0.0',
          bin: { missing: 'optional-missing.js', adapter: entrypoint },
          scripts: { postinstall: 'never-run' },
        }),
      );
      const product = {
        ...entry,
        distribution: {
          npx: {
            package: '@example/adapter@2.1.0',
            args: ['--acp'],
            env: { TOKEN: 'never-import' },
          },
        },
      };
      for (const options of [
        { directory: root, path: '' },
        { directory: packageRoot, path: '' },
        { path: root },
      ]) {
        const result = discoverAgentEntries(product, 'windows-x86_64', [], options);
        expect(result.candidates).toEqual([
          expect.objectContaining({
            source: 'package',
            packageName: '@example/adapter',
            packageVersion: '2.0.0',
            runtime: { type: 'acp-stdio', command: process.execPath, args: [script] },
          }),
        ]);
        expect(JSON.stringify(result)).not.toContain('never-import');
      }
      expect(existsSync(marker)).toBe(false);
      // A similarly placed package for a different product cannot impersonate this one.
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'different', bin: 'dist/index.js' }),
      );
      expect(
        discoverAgentEntries(product, 'windows-x86_64', [], { directory: root, path: '' })
          .candidates,
      ).toEqual([]);
      writeFileSync(join(root, 'outside.js'), '');
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@example/adapter', bin: '../../../outside.js' }),
      );
      expect(
        discoverAgentEntries(product, 'windows-x86_64', [], { directory: root, path: '' })
          .candidates,
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('reports no local install for package-only products instead of installing a package', () => {
  const isFile = vi.fn(() => true);
  const result = discoverAgentEntries(
    { ...entry, distribution: { npx: { package: 'sample@1.0.0' } } },
    'windows-x86_64',
    [],
    { isFile },
  );
  expect(result.candidates).toEqual([]);
  expect(isFile).toHaveBeenCalledWith(process.execPath);
});
