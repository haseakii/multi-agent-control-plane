import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitExecutor } from './types.js';

const execFileAsync = promisify(execFile);

export class NodeGitExecutor implements GitExecutor {
  async run(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  }
}
