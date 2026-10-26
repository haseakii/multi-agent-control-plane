import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { adapterRuntimeEnvironment } from './agent-install-adapters.js';
import { managedAgentRuntime } from './agent-launcher.js';
import { installAgentPackage, packagePlan } from './agent-package-install.js';
import type { NetworkSettingsService } from './network-settings.js';
import { InstallProcessError } from './agent-install-process.js';

it.skipIf(process.platform !== 'win32')(
  'binds Claude terminal login and SDK execution to the same installation-owned native CLI',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-adapter-'));
    try {
      const entry = join(root, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
      const sdk = join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
      const native = join(
        root,
        'node_modules/@anthropic-ai/claude-agent-sdk-win32-' + process.arch,
      );
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, 'inert');
      mkdirSync(sdk, { recursive: true });
      writeFileSync(
        join(sdk, 'package.json'),
        JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', main: 'sdk.mjs' }),
      );
      writeFileSync(join(sdk, 'sdk.mjs'), 'inert');
      mkdirSync(native, { recursive: true });
      writeFileSync(join(native, 'package.json'), '{}');
      writeFileSync(join(native, 'claude.exe'), 'inert native');
      const env = await adapterRuntimeEnvironment(
        '@agentclientprotocol/claude-agent-acp',
        root,
        entry,
      );
      expect(env).toEqual({ CLAUDE_CODE_EXECUTABLE: join(root, 'runtime/claude.exe') });
      expect(statSync(join(root, 'runtime/claude.exe')).ino).toBe(
        statSync(join(native, 'claude.exe')).ino,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'win32')(
  'binds Codex to its own short native entry instead of a global CLI',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-adapter-'));
    try {
      const entry = join(root, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js');
      const cli = join(root, 'node_modules/@openai/codex/bin/codex.js');
      const native = join(root, 'node_modules/@openai/codex-win32-' + process.arch);
      const binary = join(
        native,
        'vendor',
        process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc',
        'bin/codex.exe',
      );
      const helper = join(
        native,
        'vendor',
        process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc',
        'path/rg.exe',
      );
      for (const file of [entry, cli, binary, helper]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'inert fixture');
      }
      writeFileSync(join(native, 'package.json'), '{}');
      const binding = await adapterRuntimeEnvironment(
        '@agentclientprotocol/codex-acp',
        root,
        entry,
      );
      expect(binding.CODEX_PATH).toBe(join(root, 'runtime/bin/codex.exe'));
      expect(statSync(binding.CODEX_PATH!).ino).toBe(statSync(binary).ino);
      expect(statSync(join(root, 'runtime/path/rg.exe')).ino).toBe(statSync(helper).ino);
      expect(await adapterRuntimeEnvironment('@untrusted/codex-acp', root, entry)).toEqual({});
      expect(
        await adapterRuntimeEnvironment('@agentclientprotocol/codex-acp', root, entry),
      ).toEqual(binding);
      await expect(
        adapterRuntimeEnvironment(
          '@agentclientprotocol/codex-acp',
          join(root, 'node_modules/@agentclientprotocol'),
          entry,
        ),
      ).rejects.toThrow('本次目录');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('keeps the installed runtime binding during terminal auth while dropping catalog session settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-adapter-'));
  try {
    const script = join(root, 'entry.mjs');
    writeFileSync(
      script,
      'console.log(JSON.stringify({binary:process.env.CODEX_PATH,session:process.env.FIXTURE_MODEL,args:process.argv.slice(2)}));',
    );
    const runtime = managedAgentRuntime({
      directory: root,
      command: process.execPath,
      prefixArgs: [script],
      args: ['--acp'],
      environment: { FIXTURE_MODEL: 'session-only' },
      runtimeEnvironment: { CODEX_PATH: join(root, 'owned.exe') },
    });
    const result = await promisify(execFile)(
      runtime.command,
      [runtime.args[0]!, '--cli', 'login'],
      { windowsHide: true, timeout: 10000, env: { ...process.env, CP_TERMINAL_AUTH: '1' } },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      binary: join(root, 'owned.exe'),
      args: ['--cli', 'login'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it('automatically retries a generic base install without requiring a reviewed product ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-adapter-'));
  try {
    mkdirSync(join(root, 'runtime/npm/bin'), { recursive: true });
    writeFileSync(join(root, 'runtime/npm/bin/npm-cli.js'), 'fixture');
    const directory = join(root, 'installed');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new InstallProcessError(true))
      .mockImplementationOnce(async () => {
        const pkg = join(directory, 'node_modules/@tencent-ai/codebuddy-code');
        mkdirSync(join(pkg, 'bin'), { recursive: true });
        writeFileSync(
          join(pkg, 'package.json'),
          JSON.stringify({
            name: '@tencent-ai/codebuddy-code',
            version: '2.176.0',
            bin: { 'codebuddy-code': 'bin/codebuddy' },
          }),
        );
        writeFileSync(join(pkg, 'bin/codebuddy'), '#!/usr/bin/env node\n');
        writeFileSync(
          join(directory, 'package-lock.json'),
          JSON.stringify({ lockfileVersion: 3, packages: {} }),
        );
      });
    const phase = vi.fn();
    const plan = packagePlan(
      {
        id: 'custom-product-id',
        name: 'CodeBuddy',
        description: 'fixture',
        license_url: 'https://example.com/LICENSE',
        version: '2.176.0',
        distribution: { npx: { package: '@tencent-ai/codebuddy-code@2.176.0', args: ['--acp'] } },
      },
      'windows-x86_64',
      true,
    );
    const result = await installAgentPackage({
      plan,
      directory,
      releaseRoot: root,
      network: { effective: () => ({ mode: 'unmanaged' }) } as unknown as NetworkSettingsService,
      phase,
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['--omit=optional', '--include=prod', '--ignore-scripts']),
    );
    expect(phase).toHaveBeenCalledWith('installing', expect.stringContaining('自动恢复'));
    expect(result.args.at(-1)).toBe('--acp');
    const permanent = vi.fn().mockRejectedValue(new InstallProcessError(false));
    await expect(
      installAgentPackage({
        plan,
        directory: join(root, 'permanent'),
        releaseRoot: root,
        network: { effective: () => ({ mode: 'unmanaged' }) } as unknown as NetworkSettingsService,
        phase,
        run: permanent,
      }),
    ).rejects.toBeInstanceOf(InstallProcessError);
    expect(permanent).toHaveBeenCalledTimes(1);
    const cancelled = new AbortController();
    const cancelRun = vi.fn().mockImplementation(async () => {
      cancelled.abort();
      throw new InstallProcessError(true);
    });
    await expect(
      installAgentPackage({
        plan,
        directory: join(root, 'cancelled'),
        releaseRoot: root,
        network: { effective: () => ({ mode: 'unmanaged' }) } as unknown as NetworkSettingsService,
        phase,
        run: cancelRun,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow();
    expect(cancelRun).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
