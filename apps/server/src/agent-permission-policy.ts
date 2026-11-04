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

/** Whether a concrete file target qualifies for task-wide workspace approval. */
export function permissionTargetRememberable(root: string, target: string): boolean {
  return permissionTargetInside(root, target) && !protectedPath.test(relative(root, target));
}

export type AgentPermissionEvaluationContext = {
  /** Temporary auto rules granted for this specific task scope */
  taskScopeAutoRules?: ReadonlySet<'commands' | 'workspaceFiles'> | undefined;
  /** Originating client information for the task */
  originClient?:
    | {
        id: string;
        profile: 'read' | 'collaborate' | 'autonomous';
        enabled: boolean;
        authorizedProjects: readonly string[];
      }
    | undefined;
  projectId?: string | undefined;
};

export function agentPermissionDecision(
  policy: ProjectPolicy,
  review: AcpPermissionReview,
  workspace?: { rootPath: string; isolated: boolean },
  context?: AgentPermissionEvaluationContext,
): 'ask' | 'auto' | 'deny' {
  const rules = policy.agentPermissions;

  // 1. Explicit deny rules always take precedence
  if (review.action === 'process.execute' && rules.commands === 'deny') {
    return 'deny';
  }
  const resolved = object(object(review.parameters).resolved);
  const isFileOp = ['read', 'write'].includes(String(resolved.fileOperation));
  if (isFileOp && rules.workspaceFiles === 'deny') {
    return 'deny';
  }

  // 2. State & Integrity check:
  // Auto approval strictly requires complete review status and no integrity red flags.
  // invalid, missing, truncated, expired, sensitive_redacted, sdk_filtered, or unverified wire must NEVER auto-approve!
  if (review.status !== 'complete') {
    return 'ask';
  }
  if (
    review.reasons.some(
      (r) =>
        r === 'sensitive_redacted' ||
        r === 'truncated' ||
        r === 'sdk_filtered' ||
        r === 'history_expired' ||
        r.startsWith('missing_') ||
        r === 'wire_unavailable',
    )
  ) {
    return 'ask';
  }

  // 3. Process / Command execution evaluation
  if (review.action === 'process.execute') {
    // Commands strictly require a trusted, non-empty command body from resolved parameters.
    // Working directory (cwd), target, or arbitrary display labels must NEVER be used as a substitute.
    const rawCommand = resolved.command;
    const commandText =
      typeof rawCommand === 'string' && rawCommand.trim().length > 0 ? rawCommand.trim() : null;
    if (!commandText) {
      return 'ask';
    }

    // Check task-scoped auto rule
    if (context?.taskScopeAutoRules?.has('commands')) {
      return 'auto';
    }

    // Check autonomous client origin
    if (
      context?.originClient?.enabled &&
      context.originClient.profile === 'autonomous' &&
      (!context.projectId || context.originClient.authorizedProjects.includes(context.projectId))
    ) {
      return 'auto';
    }

    return rules.commands;
  }

  // 4. File operations evaluation
  // Only adapter-resolved file semantics qualify. Agent-supplied labels never enable auto approval.
  if (!isFileOp) return 'ask';
  if (!workspace || !review.target || !permissionTargetInside(workspace.rootPath, review.target)) {
    return rules.outsideWorkspace;
  }
  if (!workspace.isolated || !permissionTargetRememberable(workspace.rootPath, review.target)) {
    return 'ask';
  }

  // Check task-scoped auto rule for workspace files
  if (context?.taskScopeAutoRules?.has('workspaceFiles')) {
    return 'auto';
  }

  // Check autonomous client origin for workspace files
  if (
    context?.originClient?.enabled &&
    context.originClient.profile === 'autonomous' &&
    (!context.projectId || context.originClient.authorizedProjects.includes(context.projectId))
  ) {
    return 'auto';
  }

  return rules.workspaceFiles;
}
