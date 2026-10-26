import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { Runner } from '@control-plane/runner';
import type { TerminalAuthenticationHandler } from '@control-plane/acp-runtime';

/** The explicit login action opens the selected Agent in its own interactive Windows console. */
export function windowsTerminalAuthentication(
  runner: Runner,
  options: { windowStyle?: 'Normal' | 'Hidden' } = {},
): TerminalAuthenticationHandler | undefined {
  const powershell = join(
    process.env.SystemRoot ?? 'C:/Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  if (process.platform !== 'win32' || !existsSync(powershell)) return undefined;
  const sibling = new URL('./terminal-auth-main.js', import.meta.url);
  let entry = fileURLToPath(
    existsSync(sibling) ? sibling : new URL('../dist/terminal-auth-main.js', import.meta.url),
  );
  let loader: string | undefined;
  if (!existsSync(entry)) {
    // Foreground development runs TypeScript directly and has no server dist.
    // Resolve the development loader here; do not depend on the agent's cwd/PATH.
    entry = fileURLToPath(new URL('./terminal-auth-main.ts', import.meta.url));
    if (!existsSync(entry)) return undefined;
    try {
      loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
    } catch {
      return undefined;
    }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$arguments=@(('\"'+$env:CP_AUTH_ENTRY+'\"'))",
    'if($env:CP_AUTH_LOADER){$arguments=@("--import", (\'"\'+$env:CP_AUTH_LOADER+\'"\'))+$arguments}',
    '$process=Start-Process -FilePath $env:CP_AUTH_NODE -ArgumentList $arguments -WindowStyle $env:CP_AUTH_WINDOW_STYLE -Wait -PassThru',
    'exit $process.ExitCode',
  ].join('\n');
  return async (request) => {
    const payload = JSON.stringify({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      environment: request.environment,
    });
    if (Buffer.byteLength(payload) > 15000)
      throw new TypeError('终端登录配置超出本机限制，未启动。');
    const handle = await runner.spawn({
      agentId: request.agentId,
      command: powershell,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      cwd: request.cwd,
      env: {
        CP_AUTH_ENTRY: entry,
        CP_AUTH_LOADER: loader ?? '',
        CP_AUTH_NODE: process.execPath,
        CP_AUTH_WINDOW_STYLE: options.windowStyle ?? 'Normal',
        CP_AUTH_INVOCATION: payload,
      },
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    try {
      const status = await runner.wait(handle);
      if (status.state !== 'exited' || status.exitCode !== 0)
        throw new TypeError('终端登录未完成或窗口已关闭。原有授权保留，可以重新登录。');
    } finally {
      await runner.stop(handle).catch(() => undefined);
    }
  };
}
