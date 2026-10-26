import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

const absolute = z
  .string()
  .min(1)
  .refine(isAbsolute)
  .refine((v) => !/[\0\r\n]/.test(v));
export const BackgroundStartSchema = z
  .object({
    command: absolute,
    args: z.array(z.string().refine((v) => !v.includes('\0'))),
    cwd: absolute,
    logFile: absolute,
  })
  .strict();

/** Windows CRT quoting, not shell quoting. No task content is evaluated as code. */
export function windowsArgument(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid process argument.');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

/** WMI brokers the child outside the requesting client's Windows Job lifetime. */
export async function launchBackgroundHost(connectionFile: string): Promise<void> {
  absolute.parse(connectionFile);
  const entry = new URL('./background-host-main.js', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const args = [fileURLToPath(entry), '--connection', connectionFile];
  if (process.platform !== 'win32') {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$request = $env:CONTROL_PLANE_BACKGROUND | ConvertFrom-Json',
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[UInt16]0}',
    '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=[string]$request.commandLine;CurrentDirectory=[string]$request.cwd;ProcessStartupInformation=$startup}',
    'if ($result.ReturnValue -ne 0) { throw "Background process creation failed" }',
    '[string]$result.ProcessId',
  ].join('\n');
  const { stdout } = await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        CONTROL_PLANE_BACKGROUND: JSON.stringify({
          commandLine: [process.execPath, ...args].map(windowsArgument).join(' '),
          cwd: process.cwd(),
        }),
      },
    },
  );
  if (!/^[1-9][0-9]*$/.test(stdout.trim())) throw new Error('Background process not confirmed.');
}
