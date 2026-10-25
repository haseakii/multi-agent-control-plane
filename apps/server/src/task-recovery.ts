import type { AuditEvent, ExecutionAttempt, Task } from '@control-plane/core';
import { z } from 'zod';

export const RecoveryDiagnosticSchema = z.object({
  version: z.literal(1),
  reason: z.enum([
    'newer_round_available',
    'waiting_approval',
    'cleanup_in_progress',
    'executing',
    'execution_completed',
    'execution_interrupted',
    'connection_lost',
    'upstream_failure',
    'incomplete_turn',
    'execution_failed',
    'cancelled',
    'waiting_dependencies',
    'awaiting_dispatch',
    'blocked',
    'state_requires_inspection',
  ]),
  actionOwner: z.enum(['operator', 'coordinator', 'runtime', 'none']),
  nextAction: z.enum([
    'read_latest_task',
    'review_approval',
    'wait',
    'verify_outputs',
    'inspect_before_resume',
    'inspect_dependencies',
    'inspect_dispatch',
    'inspect_workbench',
    'await_user_direction',
  ]),
  executionActive: z.boolean(),
  automaticRetryAllowed: z.literal(false),
  requiresWorkspaceInspection: z.boolean(),
  pendingApprovalCount: z.number().int().nonnegative(),
  pendingApprovals: z.object({
    execution: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    push: z.number().int().nonnegative(),
  }),
  observedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime().nullable(),
  inactivityMs: z.number().nonnegative().nullable(),
  instruction: z.string(),
  title: z.string(),
  message: z.string(),
});

const descriptions: Record<RecoveryReason, [string, string]> = {
  newer_round_available: ['已有后续轮次', '请打开最新一轮继续，保留此轮历史。'],
  waiting_approval: ['等待执行授权', '请核对工作台中的执行授权请求；无需重复发送任务。'],
  cleanup_in_progress: ['正在结束执行', '运行时仍在清理，请等待完成后再审阅或继续。'],
  executing: ['成员正在执行', '继续接收过程记录；暂时没有输出不代表执行卡住。'],
  execution_completed: ['执行已结束', '请检查实际产物、文件差异和验证结果；合并仍需你审阅。'],
  execution_interrupted: ['执行已中断', '已有记录和改动保留，请检查后再恢复。'],
  connection_lost: ['成员连接已断开', '请检查成员连接和已有改动后再恢复。'],
  upstream_failure: ['上游服务返回错误', '请检查已记录的失败和已有改动后再恢复。'],
  incomplete_turn: ['本轮执行未完整结束', '请检查失败记录和已有改动后再恢复。'],
  execution_failed: ['本轮执行失败', '请检查失败原因、成员状态和已有改动后再恢复。'],
  cancelled: ['任务已停止', '记录和工作区保留，等待你的后续要求。'],
  waiting_dependencies: ['正在等待协作结果', '请查看子任务和依赖，无需重复创建任务。'],
  awaiting_dispatch: ['等待执行安排', '请检查已有任务的分配和启动状态。'],
  blocked: ['任务需要处理', '请查看记录中的阻塞原因和成员状态。'],
  state_requires_inspection: [
    '执行状态需要核对',
    '当前没有匹配的执行或授权等待，请检查记录后再操作。',
  ],
};

export type RecoveryDiagnostic = z.infer<typeof RecoveryDiagnosticSchema>;
export type RecoveryReason = RecoveryDiagnostic['reason'];

export interface RecoveryObservation {
  task: Pick<Task, 'id' | 'state' | 'updatedAt'>;
  latestTaskId: string;
  executionActive: boolean;
  latestAttempt?: Pick<
    ExecutionAttempt,
    'id' | 'taskId' | 'state' | 'createdAt' | 'startedAt' | 'updatedAt' | 'failure'
  >;
  pendingApprovalCount: number;
  pendingApprovals?: { execution: number; review: number; push: number };
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
  const pendingApprovals = input.pendingApprovals ?? {
    execution: input.pendingApprovalCount,
    review: 0,
    push: 0,
  };
  if (
    Object.values(pendingApprovals).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    pendingApprovals.execution + pendingApprovals.review + pendingApprovals.push !==
      input.pendingApprovalCount
  )
    throw new RangeError('Approval categories must match the pending total.');
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
    pendingApprovals,
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
  ): RecoveryDiagnostic =>
    RecoveryDiagnosticSchema.parse({
      ...base,
      reason,
      actionOwner,
      nextAction,
      instruction,
      requiresWorkspaceInspection,
      title: descriptions[reason][0],
      message: descriptions[reason][1],
    });

  if (input.latestTaskId !== task.id)
    return result(
      'newer_round_available',
      'coordinator',
      'read_latest_task',
      'Read recovery.latestTaskId; do not rerun or resume this historical round.',
    );
  if (!ended.has(task.state) && pendingApprovals.execution > 0)
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
