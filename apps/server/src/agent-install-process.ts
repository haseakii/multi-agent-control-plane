import type { ExecFileOptions } from 'node:child_process';
import { LocalRunner } from '@control-plane/runner';

/** Bounded installer output with owned process-tree cancellation (including npm/uv children). */
export async function runInstallProcess(command: string, args: string[], options: ExecFileOptions) {
  options.signal?.throwIfAborted();
  const runner = new LocalRunner({
    inheritedEnvironmentKeys: [],
    maxEnvironmentEntries: 512,
    maxEnvironmentValueBytes: 32768,
  });
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]),
    ),
  );
  const handle = await runner.spawn({
    command,
    args,
    env,
    ...(options.cwd ? { cwd: String(options.cwd) } : {}),
    ...(options.timeout ? { timeoutMs: options.timeout } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let stdout = '',
    stderr = '',
    bytes = 0;
  try {
    runner.endStdin(handle);
    for await (const event of runner.events(handle, { replay: true })) {
      if (event.type !== 'process.stdout' && event.type !== 'process.stderr') continue;
      bytes += Buffer.byteLength(event.chunk);
      if (bytes > (options.maxBuffer ?? 512000))
        throw new Error('Installer output exceeded its limit.');
      if (event.type === 'process.stdout') stdout += event.chunk;
      else stderr += event.chunk;
    }
    const status = await runner.wait(handle);
    options.signal?.throwIfAborted();
    if (status.state !== 'exited' || status.exitCode !== 0)
      throw new Error('Installer process did not complete successfully.');
    return { stdout, stderr };
  } finally {
    await runner.stop(handle, { gracePeriodMs: 0 });
  }
}
