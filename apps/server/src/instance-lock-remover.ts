import { execFileSync } from 'node:child_process';
import { fstatSync, readFileSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const IdentitySchema = z
  .object({ volumeId: z.string().regex(/^[0-9]+$/), fileId: z.string().regex(/^[1-9][0-9]*$/) })
  .strict();
export type LockFileIdentity = z.infer<typeof IdentitySchema>;
const RemovalSchema = z
  .object({
    removed: z.boolean(),
    reason: z.enum(['removed', 'owner_changed', 'unavailable', 'not_found']),
  })
  .strict();
export type LockRemoval = z.infer<typeof RemovalSchema>;
export interface InstanceLockRemover {
  remove(filename: string, identity: LockFileIdentity, token?: string): LockRemoval;
  recover?(filename: string, identity: LockFileIdentity, token: string, pid: number): LockRemoval;
}

export function lockFileIdentity(fd: number): LockFileIdentity {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('Lock identity is unavailable.');
  return IdentitySchema.parse({ volumeId: stat.dev.toString(), fileId: stat.ino.toString() });
}

export const windowsInstanceLockRemover: InstanceLockRemover = {
  remove(filename, identity, token) {
    return nativeRemove(filename, identity, token);
  },
  recover(filename, identity, token, pid) {
    return nativeRemove(filename, identity, token, pid);
  },
};
function nativeRemove(
  filename: string,
  identity: LockFileIdentity,
  token?: string,
  deadPid?: number,
): LockRemoval {
  if (
    process.platform !== 'win32' ||
    !isAbsolute(filename) ||
    basename(filename) !== 'instance.lock'
  )
    return { removed: false, reason: 'unavailable' };
  try {
    const owner = IdentitySchema.parse(identity);
    if (token !== undefined) z.uuid().parse(token);
    if (deadPid !== undefined) z.number().int().positive().max(0xffffffff).parse(deadPid);
    const native = readFileSync(new URL('./windows-lock-delete.cs', import.meta.url), 'utf8');
    const script = [
      "$ErrorActionPreference='Stop'",
      '$request = $env:CONTROL_PLANE_LOCK_REQUEST | ConvertFrom-Json',
      'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CONTROL_PLANE_LOCK_SOURCE)))',
      'if ($request.deadPid) { [ControlPlaneLockDelete]::Recover([string]$request.path,[UInt64]::Parse([string]$request.volumeId),[UInt64]::Parse([string]$request.fileId),$request.token,[UInt32]$request.deadPid) | ConvertTo-Json -Compress } else { [ControlPlaneLockDelete]::Remove([string]$request.path,[UInt64]::Parse([string]$request.volumeId),[UInt64]::Parse([string]$request.fileId),$request.token,$null) | ConvertTo-Json -Compress }',
    ].join(String.fromCharCode(10));
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
    const output = execFileSync(
      join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16_384,
        env: {
          SystemRoot: systemRoot,
          TEMP: process.env.TEMP ?? tmpdir(),
          TMP: process.env.TMP ?? tmpdir(),
          CONTROL_PLANE_LOCK_REQUEST: JSON.stringify({
            path: filename,
            ...owner,
            token: token ?? null,
            deadPid,
          }),
          CONTROL_PLANE_LOCK_SOURCE: Buffer.from(native).toString('base64'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return RemovalSchema.parse(JSON.parse(output));
  } catch {
    // Missing primitive, policy restrictions, identity uncertainty or access denial: retain the path.
    // Never fall back to unlink/rm/rename and never change ACLs or execution policy.
    return { removed: false, reason: 'unavailable' };
  }
}
