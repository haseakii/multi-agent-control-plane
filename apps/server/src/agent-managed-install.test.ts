import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { packagePlan, installAgentPackage, npmRuntime } from './agent-package-install.js';
import { managedAgentRuntime } from './agent-launcher.js';
import { installPythonAgent } from './agent-python-runtime.js';
import { extractAgentTar } from './agent-package-io.js';
import type { NetworkSettingsService } from './network-settings.js';

const base = {
  id: 'fixture',
  name: 'Fixture',
  version: '1.0.0',
  description: 'Local fixture',
  license_url: 'https://example.com/LICENSE',
};
function remove(root: string) {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
  expect(basename(root)).toMatch(/^acp-managed-/);
  rmSync(root, { recursive: true, force: true });
}

it('plans fixed Python packages and non-secret catalog settings without granting host overrides', () => {
  for (const source of ['fixture==1.2.3', 'fixture@1.2.3']) {
    expect(
      packagePlan(
        { ...base, distribution: { uvx: { package: source, env: { FIXTURE_MODEL: 'default' } } } },
        'windows-x86_64',
        true,
      ),
    ).toMatchObject({
      runtime: 'Python（自动准备）',
      distribution: {
        kind: 'uv',
        source: 'fixture==1.2.3',
        environment: { FIXTURE_MODEL: 'default' },
      },
    });
  }
  for (const env of [
    { PATH: 'override' },
    { NODE_OPTIONS: '--require untrusted' },
    { AGENT_API_KEY: 'do-not-copy' },
  ])
    expect(() =>
      packagePlan(
        { ...base, distribution: { npx: { package: 'fixture@1.0.0', env } } },
        'windows-x86_64',
        true,
      ),
    ).toThrow('环境设置不能自动应用');
});

it.skipIf(process.platform !== 'win32')(
  'runs managed batch entries under Unicode and special-character directories and refuses command expansion',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-managed-'));
    try {
      const folder = join(root, '中文 & %参数%');
      mkdirSync(folder);
      const command = join(folder, 'agent.cmd');
      writeFileSync(command, '@echo off\r\necho %FIXTURE_MODE%\r\necho %~1\r\n');
      const runtime = managedAgentRuntime({
        directory: folder,
        command,
        args: ['hello world'],
        environment: { FIXTURE_MODE: 'fixture-ready' },
      });
      const run = promisify(execFile);
      const output = await run(runtime.command, runtime.args, { windowsHide: true, timeout: 5000 });
      expect(output.stdout.replaceAll('\r', '').trim()).toBe('fixture-ready\nhello world');
      await expect(
        run(runtime.command, [runtime.args[0]!, '& echo unexpected'], {
          windowsHide: true,
          timeout: 5000,
        }),
      ).rejects.toThrow();
    } finally {
      remove(root);
    }
  },
);

it('installs a nested tar program and rejects traversal or link headers before extraction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-managed-'));
  try {
    const npm = npmRuntime(root)!;
    const tar = createRequire(npm)('tar');
    const program = join(root, 'source');
    mkdirSync(join(program, 'nested'), { recursive: true });
    writeFileSync(join(program, 'nested/worker.exe'), 'inert program, never executed');
    const archive = join(root, 'source.tar.gz');
    await tar.c({ cwd: program, gzip: true, file: archive }, ['nested']);
    const bytes = readFileSync(archive);
    const plan = packagePlan(
      {
        ...base,
        distribution: {
          binary: {
            'windows-x86_64': {
              archive: 'https://example.com/source.tar.gz',
              cmd: './nested/worker.exe',
            },
          },
        },
      },
      'windows-x86_64',
      true,
    );
    const runtime = await installAgentPackage({
      plan,
      directory: join(root, 'installed'),
      releaseRoot: root,
      network: { fetch: async () => new Response(bytes) } as unknown as NetworkSettingsService,
      phase: vi.fn(),
    });
    expect(readFileSync(runtime.command, 'utf8')).toContain('never executed');
    for (const [path, type] of [
      ['../escape', '0'],
      ['linked', '2'],
    ]) {
      const header = Buffer.alloc(512);
      header.write(path!);
      header.write('0000644\0', 100);
      header.write('0000000\0', 108);
      header.write('0000000\0', 116);
      header.write('00000000000\0', 124);
      header.write('00000000000\0', 136);
      header.fill(32, 148, 156);
      header.write(type!, 156);
      header.write('../outside', 157);
      header.write('ustar\0', 257);
      header.write('00', 263);
      const checksum = header
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, '0');
      header.write(checksum + '\0 ', 148);
      const invalid = join(root, type + '.tar');
      writeFileSync(invalid, Buffer.concat([header, Buffer.alloc(1024)]));
      await expect(extractAgentTar(invalid, join(root, 'rejected-' + type), npm)).rejects.toThrow(
        '解压未完成',
      );
    }
  } finally {
    remove(root);
  }
});

it('keeps Python preparation, package installation and generated entrypoints inside private directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-managed-'));
  try {
    const directory = join(root, 'agent');
    mkdirSync(directory);
    const run = vi.fn(
      async (
        _command: string,
        _args: string[],
        _options: import('node:child_process').ExecFileOptions,
      ) => ({ stdout: JSON.stringify({ python: '3.13.8', entries: ['fixture'] }) }),
    );
    const result = await installPythonAgent({
      source: 'fixture==1.0.0',
      packageName: 'fixture',
      directory,
      runtimeRoot: join(root, 'runtimes'),
      uvExecutable: process.execPath,
      run,
      phase: vi.fn(),
      network: { effective: () => ({ mode: 'unmanaged' }) } as unknown as NetworkSettingsService,
    });
    expect(run.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['python', 'install', '--no-bin', '--no-registry', '--no-config']),
    );
    expect(run.mock.calls[1]?.[1]).toContain('--managed-python');
    expect(run.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        '--python',
        result.command,
        '--only-binary',
        ':all:',
        '--index-url',
        'https://pypi.org/simple',
        'fixture==1.0.0',
      ]),
    );
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      env: {
        UV_PYTHON_INSTALL_DIR: join(root, 'runtimes/python'),
        UV_PYTHON_INSTALL_REGISTRY: '0',
      },
    });
    expect(readFileSync(result.prefixArgs[0]!, 'utf8')).toContain('importlib.metadata');
  } finally {
    remove(root);
  }
});
