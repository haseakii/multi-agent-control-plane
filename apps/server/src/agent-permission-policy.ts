import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AcpPermissionReview, ProjectPolicy } from '@control-plane/core';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const protectedPath =
  /(^|[\\/])(?:\.git|\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.codex|\.npmrc|credentials?[^\\/]*|[^\\/]*\.(?:pem|key|pfx))([\\/]|$)/i;

/** Classification of the requested file, not OS confinement of an agent-owned tool. */
export function permissionTargetInside(root: string, target: string): boolean {
  if (!isAbsolute(target)) return false;
  try {
    const canonical = realpathSync(root);
    const local = relative(canonical, resolve(target));
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) return false;
    let current = canonical;
    for (const part of local.split(sep)) {
      // NTFS alternate data streams and device-like path components are never automatic.
      if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)) return false;
      current = resolve(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function agentPermissionDecision(
  policy: ProjectPolicy,
  review: AcpPermissionReview,
  workspace?: { rootPath: string; isolated: boolean },
): 'ask' | 'auto' | 'deny' {
  const rules = policy.agentPermissions;
  if (review.action === 'process.execute') return rules.commands;
  if (review.status !== 'complete') return 'ask';
  const resolved = object(object(review.parameters).resolved);
  // Only adapter-resolved file semantics qualify. Agent-supplied labels never enable auto approval.
  if (!['read', 'write'].includes(String(resolved.fileOperation))) return 'ask';
  if (!workspace || !review.target || !permissionTargetInside(workspace.rootPath, review.target))
    return rules.outsideWorkspace;
  if (rules.workspaceFiles === 'deny') return 'deny';
  if (!workspace.isolated || protectedPath.test(relative(workspace.rootPath, review.target)))
    return 'ask';
  return rules.workspaceFiles;
}
