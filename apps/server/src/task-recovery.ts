import type { AuditEvent, ExecutionAttempt, Task } from '@control-plane/core';

export type RecoveryReason =
  | 'newer_round_available'
  | 'waiting_approval'
  | 'cleanup_in_progress'
  | 'executing'
  | 'execution_completed'
  | 'execution_interrupted'
  | 'connection_lost'
  | 'upstream_failure'
  | 'incomplete_turn'
  | 'execution_failed'
  | 'cancelled'
  | 'waiting_dependencies'
  | 'awaiting_dispatch'
  | 'blocked'
  | 'state_requires_inspection';

export interface RecoveryDiagnostic {
  version: 1;
  reason: RecoveryReason;
  actionOwner: 'operator' | 'coordinator' | 'runtime' | 'none';
  nextAction:
    | 'read_latest_task'
    | 'review_approval'
    | 'wait'
    | 'verify_outputs'
    | 'inspect_before_resume'
    | 'inspect_dependencies'
    | 'inspect_dispatch'
    | 'inspect_workbench'
    | 'await_user_direction';
  executionActive: boolean;
  automaticRetryAllowed: false;
  requiresWorkspaceInspection: boolean;
  pendingApprovalCount: number;
  observedAt: string;
  lastActivityAt: string | null;
  inactivityMs: number | null;
  instruction: string;
}

export interface RecoveryObservation {
  task: Pick<Task, 'id' | 'state' | 'updatedAt'>;
  latestTaskId: string;
  executionActive: boolean;
  latestAttempt?: Pick<
    ExecutionAttempt,
    'id' | 'taskId' | 'state' | 'createdAt' | 'startedAt' | 'updatedAt' | 'failure'
  >;
  pendingApprovalCount: number;
  events: readonly Pick<AuditEvent, 'taskId' | 'type' | 'occurredAt' | 'payload'>[];
  now: number;
}

// Read/audit traffic is not evidence of execution progress. These are observations,
// not a heartbeat or proof that a model/tool is still making useful progress.
const activityEvents = new Set([
  'agent.progress',
  'agent.tool',
  'agent.usage',
  'execution.failed',
  'execution.outcome.corrected',
  'approval.decided',
  'task.retry_requested',
  'workspace.continued',
]);
const ended = new Set<Task['state']>(['completed', 'failed', 'cancelled']);

/** Derive guidance only. Never mutate tasks, approve tools, retry, or spawn an agent. */
export function diagnoseTaskRecovery(input: RecoveryObservation): RecoveryDiagnostic {
  if (!Number.isFinite(input.now)) throw new RangeError('A finite observation time is required.');
  if (!Number.isSafeInteger(input.pendingApprovalCount) || input.pendingApprovalCount < 0)
    throw new RangeError('A nonnegative approval count is required.');
  const { task } = input;
  const attempt = input.latestAttempt?.taskId === task.id ? input.latestAttempt : undefined;
  const attemptStart = Date.parse(attempt?.startedAt ?? attempt?.createdAt ?? '');
  const times = [task.updatedAt, attempt?.updatedAt];
  for (const event of input.events) {
    if (event.taskId !== task.id || !activityEvents.has(event.type)) continue;
    if (attempt && event.payload.attemptId && event.payload.attemptId !== attempt.id) continue;
    if (Number.isFinite(attemptStart) && Date.parse(event.occurredAt) < attemptStart) continue;
    times.push(event.occurredAt);
  }
  const observedTimes = times
    .map((value) => Date.parse(value ?? ''))
    .filter((value) => Number.isFinite(value) && value <= input.now);
  const lastActivity = observedTimes.reduce<number | null>(
    (latest, value) => (latest === null || value > latest ? value : latest),
    null,
  );
  const base = {
    version: 1 as const,
    executionActive: input.executionActive,
    automaticRetryAllowed: false as const,
    requiresWorkspaceInspection: false,
    pendingApprovalCount: input.pendingApprovalCount,
    observedAt: new Date(input.now).toISOString(),
    lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
    inactivityMs: lastActivity === null ? null : input.now - lastActivity,
  };
  const result = (
    reason: RecoveryReason,
    actionOwner: RecoveryDiagnostic['actionOwner'],
    nextAction: RecoveryDiagnostic['nextAction'],
    instruction: string,
    requiresWorkspaceInspection = false,
  ): RecoveryDiagnostic => ({
    ...base,
    reason,
    actionOwner,
    nextAction,
    instruction,
    requiresWorkspaceInspection,
  });

  if (input.latestTaskId !== task.id)
    return result(
      'newer_round_available',
      'coordinator',
      'read_latest_task',
      'Read recovery.latestTaskId; do not rerun or resume this historical round.',
    );
  if (input.pendingApprovalCount > 0)
    return result(
      'waiting_approval',
      'operator',
      'review_approval',
      'Review pending approvals in the workbench. Waiting for permission is not a stuck execution. Do not bypass or auto-approve them.',
    );
  if (input.executionActive)
    return ended.has(task.state)
      ? result(
          'cleanup_in_progress',
          'runtime',
          'wait',
          'Execution cleanup is still active. Keep this task ID and wait; do not submit another attempt or prepare a review yet.',
        )
      : result(
          'executing',
          'runtime',
          'wait',
          'Continue reading this task with its event cursor. A quiet stream alone does not prove a hang or authorize a retry.',
        );
  if (task.state === 'cancelled')
    return result(
      'cancelled',
      'none',
      'await_user_direction',
      'The task was cancelled. Retain its history and workspace; do not restart without a new user direction.',
    );
  if (task.state === 'completed')
    return result(
      'execution_completed',
      'coordinator',
      'verify_outputs',
      'Execution ended, not acceptance. Inspect actual artifacts, code changes and test evidence before preparing human review; do not auto-merge or push.',
    );
  if (task.state === 'failed' || attempt?.state === 'interrupted') {
    const code = attempt?.failure?.code;
    const reason: RecoveryReason =
      attempt?.state === 'interrupted' || code === 'CONTROL_PLANE_RESTART'
        ? 'execution_interrupted'
        : code === 'ACP_CONNECTION_CLOSED'
          ? 'connection_lost'
          : code === 'AGENT_UPSTREAM_INTERNAL'
            ? 'upstream_failure'
            : code === 'ACP_TURN_INCOMPLETE'
              ? 'incomplete_turn'
              : 'execution_failed';
    return result(
      reason,
      'operator',
      'inspect_before_resume',
      'Inspect the latest failure, member readiness and existing workspace changes before explicitly resuming or continuing. A retryable error does not prove side effects are safe to repeat. Do not submit a duplicate task.',
      true,
    );
  }
  if (task.state === 'waiting')
    return result(
      'waiting_dependencies',
      'coordinator',
      'inspect_dependencies',
      'Inspect child tasks and dependencies before continuing this task. Do not replace waiting work with a duplicate submission.',
    );
  if (['draft', 'planning', 'ready'].includes(task.state))
    return result(
      'awaiting_dispatch',
      'coordinator',
      'inspect_dispatch',
      'Check the existing task assignment and dispatch state. No execution is observed; this is not evidence that a new task should be submitted.',
    );
  if (task.state === 'blocked')
    return result(
      'blocked',
      'operator',
      'inspect_workbench',
      'Inspect the recorded blocker and member readiness in the workbench. Do not unblock or switch agents automatically.',
    );
  return result(
    'state_requires_inspection',
    'operator',
    'inspect_workbench',
    'Durable state has no matching active execution or pending approval. Inspect the workbench before changing state; do not infer a timeout, expired login, or exhausted quota from silence.',
  );
}
