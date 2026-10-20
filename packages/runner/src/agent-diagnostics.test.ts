import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectAgentConfiguration } from './agent-diagnostics.js';
import { windowsWrapperIssue } from './windows-command.js';

const example = JSON.parse(
  readFileSync(
    new URL('../../../examples/agents/codex-acp.windows.disabled.json', import.meta.url),
    'utf8',
  ),
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('offline agent preparation', () => {
  it('validates the disabled example using only its two configured file paths', () => {
    const isFile = vi.fn(() => true);
    const result = inspectAgentConfiguration(example, { platform: 'win32', isFile });
    expect(result).toMatchObject({
      configurationValid: true,
      enabled: false,
      offlineChecksPassed: true,
      runtime: 'not_started',
      authentication: 'not_checked',
      model: 'not_requested',
    });
    expect(isFile.mock.calls).toEqual([[example.runtime.command], [example.runtime.args[0]]]);
    expect(example.orchestration.canBeBoss).toBe(false);
    expect(example.controlBridge).toEqual({ transport: 'none', scopes: [] });
    expect(example.runtime.environmentAllowlist).toEqual([]);
  });

  it.each(['.cmd', '.CMD', '.bat', '.ps1'])(
    'diagnoses a Windows %s wrapper before agent execution',
    (extension) => {
      const result = inspectAgentConfiguration(
        { ...example, runtime: { ...example.runtime, command: `C:/adapters/agent${extension}` } },
        { platform: 'win32', isFile: () => true },
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'WINDOWS_WRAPPER_UNSUPPORTED',
          message: expect.stringContaining('node.exe'),
        }),
      );
      expect(windowsWrapperIssue(`C:/adapters/agent${extension}`, 'linux')).toBeUndefined();
    },
  );

  it('rejects invalid configuration without echoing its contents or inspecting paths', () => {
    const isFile = vi.fn(() => true);
    const result = inspectAgentConfiguration(
      { privateValue: 'do-not-echo-this-value' },
      { isFile },
    );
    expect(result.configurationValid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('do-not-echo-this-value');
    expect(isFile).not.toHaveBeenCalled();
  });

  it('does not search PATH and reports a missing Node adapter entrypoint', () => {
    expect(
      inspectAgentConfiguration(
        { ...example, runtime: { ...example.runtime, command: 'node.exe' } },
        { platform: 'win32', isFile: () => true },
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'COMMAND_NOT_ABSOLUTE' }));
    const result = inspectAgentConfiguration(example, {
      platform: 'win32',
      isFile: (path) => path === example.runtime.command,
    });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'NODE_ENTRY_NOT_FILE' }));
  });

  it('the CLI inspects a valid config without running its adapter or echoing arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'control-plane-offline-diagnosis-'));
    directories.push(directory);
    const marker = join(directory, 'adapter-was-started');
    const entry = join(directory, 'adapter.mjs');
    writeFileSync(
      entry,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`,
    );
    const config = join(directory, 'agent.json');
    writeFileSync(
      config,
      JSON.stringify({
        ...example,
        runtime: {
          type: 'acp-stdio',
          command: process.execPath,
          args: [entry, 'do-not-echo-this-argument'],
          environmentAllowlist: ['DO_NOT_INSPECT_AUTH'],
        },
      }),
    );
    const cli = fileURLToPath(new URL('./diagnose-agent.ts', import.meta.url));
    const inspected = spawnSync(process.execPath, ['--import', 'tsx', cli, '--config', config], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      offlineChecksPassed: true,
      enabled: false,
      authentication: 'not_checked',
    });
    expect(inspected.stdout).not.toContain('do-not-echo-this-argument');
    expect(existsSync(marker)).toBe(false);
    const refused = spawnSync(process.execPath, ['--import', 'tsx', cli, '--start'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    expect(refused.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });
});
