import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Prefer the verified package's matched Node/npm for member-owned subprocesses. */
export function preferBundledRuntime(root: string, environment: NodeJS.ProcessEnv = process.env) {
  const runtime = join(root, 'runtime');
  if (
    !['node.exe', 'npm.cmd', 'npx.cmd', 'npm/bin/npm-cli.js', 'npm/bin/npx-cli.js'].every((file) =>
      existsSync(join(runtime, file)),
    )
  )
    return false;
  const key = Object.keys(environment).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const current = (environment[key] ?? '').split(delimiter).filter((path) => path !== runtime);
  environment[key] = [runtime, ...current].join(delimiter);
  return true;
}
