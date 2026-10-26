import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { installAgentPackage, packagePlan } from './agent-package-install.js';
import { resolveNetwork, type NetworkSettingsService } from './network-settings.js';
import { NetworkSettingsSchema } from '@control-plane/core';
import { downloadPackageFile } from './agent-package-io.js';
import { inspectAgentConfiguration } from '@control-plane/runner';

it('cancels a stalled download body and closes its output file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-download-cancel-'));
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const cancelled = vi.fn();
  try {
    const pending = downloadPackageFile({
      source: 'https://example.com/worker.exe',
      destination: join(root, 'partial'),
      signal: controller.signal,
      network: {
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull() {
                ready.resolve();
              },
              cancel: cancelled,
            }),
          ),
      },
    });
    const rejected = expect(pending).rejects.toThrow();
    await ready.promise;
    controller.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalled();
    writeFileSync(join(root, 'partial'), 'retained cancellation evidence');
  } finally {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports streamed bytes, avoids invented totals, and does not report verified completion on checksum failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-download-progress-'));
  const clock = vi.spyOn(performance, 'now');
  let tick = 0;
  clock.mockImplementation(() => (tick += 300));
  try {
    const cases = [
      { headers: { 'content-length': '6' }, totalBytes: 6 },
      { headers: {}, totalBytes: undefined },
      { headers: { 'content-length': '3' }, totalBytes: undefined },
      { headers: { 'content-length': '100', 'content-encoding': 'gzip' }, totalBytes: undefined },
    ];
    for (const [index, item] of cases.entries()) {
      const progress = vi.fn();
      await downloadPackageFile({
        source: 'https://example.com/worker.exe',
        destination: join(root, String(index)),
        network: {
          fetch: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from('abc'));
                  controller.enqueue(Buffer.from('def'));
                  controller.close();
                },
              }),
              { headers: item.headers },
            ),
        },
        progress,
      });
      expect(progress.mock.calls.map(([value]) => value.receivedBytes)).toEqual([0, 3, 6, 6]);
      expect(progress.mock.lastCall?.[0].totalBytes).toBe(item.totalBytes);
      expect(readFileSync(join(root, String(index)), 'utf8')).toBe('abcdef');
    }
    const progress = vi.fn();
    await expect(
      downloadPackageFile({
        source: 'https://example.com/worker.exe',
        destination: join(root, 'bad'),
        network: { fetch: async () => new Response('bad') },
        sha256: '0'.repeat(64),
        maxAttempts: 1,
        progress,
      }),
    ).rejects.toThrow('SHA-256');
    expect(progress).toHaveBeenCalledTimes(2); // initial + received chunk, no verified final report
  } finally {
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
const base = {
  id: 'fixture',
  name: 'Fixture',
  version: '1.0.0',
  description: 'Inert fixture',
  license_url: 'https://example.com/LICENSE',
};
it.skipIf(process.platform !== 'win32')(
  'downloads, verifies and extracts an inert ZIP without executing it',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-package-'));
    try {
      const source = join(root, 'source');
      mkdirSync(source);
      writeFileSync(join(source, 'worker.exe'), 'inert test data, never executed');
      const archive = join(root, 'fixture.zip');
      execFileSync(
        join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CP_ZIP_SOURCE,$env:CP_ZIP_TARGET)',
        ],
        {
          windowsHide: true,
          env: { ...process.env, CP_ZIP_SOURCE: source, CP_ZIP_TARGET: archive },
        },
      );
      const bytes = readFileSync(archive),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const plan = packagePlan(
        {
          ...base,
          distribution: {
            binary: {
              'windows-x86_64': {
                archive: 'https://example.com/fixture.zip',
                cmd: './worker.exe',
                sha256,
              },
            },
          },
        },
        'windows-x86_64',
        false,
      );
      const request = vi.fn().mockImplementation(() => Promise.resolve(new Response(bytes)));
      const network = { fetch: request } as unknown as NetworkSettingsService;
      const runtime = await installAgentPackage({
        plan,
        directory: join(root, 'installed'),
        releaseRoot: root,
        network,
        phase: vi.fn(),
      });
      expect(runtime.command).toBe(join(root, 'installed/program/worker.exe'));
      expect(readFileSync(runtime.command, 'utf8')).toContain('never executed');
      expect(request).toHaveBeenCalledWith(
        new URL('https://example.com/fixture.zip'),
        expect.objectContaining({ redirect: 'manual' }),
      );
      await expect(
        installAgentPackage({
          plan: { ...plan, distribution: { ...plan.distribution, sha256: '0'.repeat(64) } },
          directory: join(root, 'corrupt'),
          releaseRoot: root,
          network,
          phase: vi.fn(),
        }),
      ).rejects.toThrow('SHA-256');
      expect(existsSync(join(root, 'corrupt/program'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
it.each(['main.js', 'bin/acp'])(
  'installs and validates the local npm Node entry %s',
  async (entry) => {
    const root = mkdtempSync(join(tmpdir(), 'acp-npm-'));
    try {
      mkdirSync(join(root, 'runtime/npm/bin'), { recursive: true });
      writeFileSync(join(root, 'runtime/npm/bin/npm-cli.js'), 'fixture');
      const plan = packagePlan(
        { ...base, distribution: { npx: { package: '@fixture/acp@1.2.3', args: ['--acp'] } } },
        'windows-x86_64',
        true,
      );
      const effective = resolveNetwork(
        NetworkSettingsSchema.parse({
          revision: 1,
          updatedAt: null,
          global: { mode: 'proxy', proxyUrl: 'http://127.0.0.1:7897' },
          members: {},
        }),
      );
      const network = { effective: () => effective } as NetworkSettingsService;
      const directory = join(root, 'installed');
      const run = vi.fn(async () => {
        const pkg = join(directory, 'node_modules/@fixture/acp');
        mkdirSync(dirname(join(pkg, entry)), { recursive: true });
        writeFileSync(
          join(pkg, 'package.json'),
          JSON.stringify({
            name: '@fixture/acp',
            version: '1.2.3',
            bin: { acp: entry, helper: 'unused-helper.js' },
          }),
        );
        writeFileSync(
          join(pkg, entry),
          '#!/usr/bin/env node\nthrow new Error("must not execute");',
        );
        writeFileSync(
          join(directory, 'package-lock.json'),
          JSON.stringify({
            lockfileVersion: 3,
            packages: { 'node_modules/@fixture/acp': { version: '1.2.3' } },
          }),
        );
      });
      const runtime = await installAgentPackage({
        plan,
        directory,
        releaseRoot: root,
        network,
        nodeExecutable: process.execPath,
        phase: vi.fn(),
        run,
      });
      expect(run).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([
          '--prefix',
          directory,
          '--global=false',
          '--ignore-scripts',
          '--include=optional',
          '--package-lock=true',
          '--save-exact',
          '@fixture/acp@1.2.3',
        ]),
        expect.objectContaining({
          windowsHide: true,
          env: expect.objectContaining({
            npm_config_https_proxy: 'http://127.0.0.1:7897',
            HTTPS_PROXY: 'http://127.0.0.1:7897',
            npm_config_cache: join(directory, 'cache'),
          }),
        }),
      );
      expect(runtime).toEqual({
        type: 'acp-stdio',
        command: process.execPath,
        args: [join(directory, 'node_modules/@fixture/acp', entry), '--acp'],
      });
      expect(
        inspectAgentConfiguration({
          id: 'fixture',
          name: 'Fixture',
          enabled: true,
          runtime,
          capabilities: [],
          auth: { mode: 'agent-managed' },
          orchestration: { canBeBoss: false },
          controlBridge: { transport: 'none', scopes: [] },
        }).offlineChecksPassed,
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
