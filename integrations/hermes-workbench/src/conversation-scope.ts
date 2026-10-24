interface TaskScope {
  id: string;
  projectId: string;
  parentTaskId?: string;
}

interface ApprovalScope {
  projectId: string;
  taskId?: string;
  state: string;
}

/** Presentation scope only; the server still decides whether a request may be approved. */
export function pendingTaskApprovals<T extends ApprovalScope>(
  approvals: readonly T[],
  tasks: readonly TaskScope[],
  current: TaskScope | undefined,
): T[] {
  if (!current) return [];
  const ids = new Set([current.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (
        task.projectId === current.projectId &&
        task.parentTaskId &&
        ids.has(task.parentTaskId) &&
        !ids.has(task.id)
      ) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  return approvals.filter(
    (approval) =>
      approval.state === 'pending' &&
      approval.projectId === current.projectId &&
      approval.taskId !== undefined &&
      ids.has(approval.taskId),
  );
}
