import { expect, it } from 'vitest';
import { InstallProcessError, runInstallProcess } from './agent-install-process.js';

it.each([
  ['ECONNRESET', true],
  ['EAI_AGAIN', true],
  ['E404', false],
  ['EACCES', false],
] as const)(
  'classifies installer error %s without exposing provider output',
  async (code, retryable) => {
    const error = await runInstallProcess(
      process.execPath,
      [
        '-e',
        'process.stderr.write(process.argv[1]);process.exit(1)',
        'npm error code ' + code + '\nprivate-provider-log',
      ],
      { timeout: 10000, windowsHide: true },
    ).catch((error) => error);
    expect(error).toBeInstanceOf(InstallProcessError);
    expect(error.retryable).toBe(retryable);
    expect(error.message).not.toContain('private-provider-log');
  },
  15000,
);
