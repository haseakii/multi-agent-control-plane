type Task = { id: string; parentTaskId?: string };
type Event = { type: string; payload?: Record<string, unknown> };

export function executionRecordUrl(taskIds: readonly string[]) {
  return `/api/control-center?view=conversation${taskIds[0] ? `&taskId=${encodeURIComponent(taskIds[0])}` : ''}`;
}

/** A round includes its delegated descendants, but not another follow-up round. */
export function executionTaskScope(
  roundIds: readonly string[],
  tasks: readonly Task[],
  selectedRound: string,
) {
  const ids = new Set(roundIds.includes(selectedRound) ? [selectedRound] : roundIds);
  for (let changed = true; changed; ) {
    changed = false;
    for (const task of tasks) {
      if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function executionEventNeedsAttention(event: Event) {
  return (
    /failed|denied|interrupt/.test(event.type) ||
    [event.payload?.outcome, event.payload?.to, event.payload?.status, event.payload?.state].some(
      (value) =>
        ['denied', 'failed', 'interrupted', 'blocked', 'waiting_approval', 'rejected'].includes(
          String(value),
        ),
    )
  );
}

export function isRoutineExecutionEvent(event: Event) {
  if (executionEventNeedsAttention(event)) return false;
  return (
    event.type === 'fleet.tool' ||
    event.type.startsWith('message.') ||
    [
      'agent.progress',
      'agent.tool',
      'agent.usage',
      'client.tool.called',
      'execution.context.prepared',
      'execution.boundary',
      'conversation.attached',
      'attempt.created',
      'task.state_changed',
    ].includes(event.type)
  );
}
