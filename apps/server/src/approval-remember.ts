import { classifyApprovalOperation, type Approval } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import { permissionTargetRememberable } from './agent-permission-policy.js';

/** Eligibility is determined from the server-owned assignment workspace, never the tool label. */
export function rememberableApprovalRule(
  storage: SqliteStorage,
  approval: Approval,
): 'commands' | 'workspaceFiles' | undefined {
  const category = classifyApprovalOperation(approval);
  const review = approval.acp?.review;
  if (!review || review.status !== 'complete' || review.reasons.length !== 0) return undefined;
  if (category === 'commands') {
    const params = review.parameters as { resolved?: { command?: unknown } };
    return review.action === 'process.execute' &&
      typeof params?.resolved?.command === 'string' &&
      params.resolved.command.trim()
      ? category
      : undefined;
  }
  if (category !== 'workspaceFiles' || !approval.acp || !approval.assignmentId || !approval.taskId)
    return undefined;
  const binding = storage.repositories.assignmentWorkspaces.get(approval.assignmentId);
  if (
    !binding ||
    binding.taskId !== approval.taskId ||
    binding.projectId !== approval.projectId ||
    !['git-worktree', 'task-local'].includes(binding.mode)
  )
    return undefined;
  const workspace = storage.repositories.workspaces.get(binding.workspaceId);
  const target = approval.acp.review.target;
  if (
    !workspace ||
    workspace.projectId !== approval.projectId ||
    !target ||
    !permissionTargetRememberable(workspace.rootPath, target)
  )
    return undefined;
  const params = approval.acp.review.parameters as { resolved?: { fileOperation?: unknown } };
  if (!['read', 'write'].includes(String(params?.resolved?.fileOperation))) return undefined;
  return 'workspaceFiles';
}
