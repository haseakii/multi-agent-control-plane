import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitExecutor } from './types.js';

const execFileAsync = promisify(execFile);

export class NodeGitExecutor implements GitExecutor {
  async run(
    cwd: string,
    args: string[],
    options?: {
      env?: Record<string, string>;
      trim?: boolean;
      maxBuffer?: number;
      timeoutMs?: number;
    },
  ): Promise<string> {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
      maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    return options?.trim === false ? result.stdout : result.stdout.trim();
  }
}
