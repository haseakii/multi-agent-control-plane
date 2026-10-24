import { describe, expect, it } from 'vitest';
import {
  diagnoseTaskRecovery,
  type RecoveryObservation,
  type RecoveryReason,
} from './task-recovery.js';

const initial = '2026-10-24T12:00:00.000Z';
const now = Date.parse('2026-10-24T12:10:00.000Z');
function observation(overrides: Partial<RecoveryObservation> = {}): RecoveryObservation {
  return {
    task: { id: 'task' as RecoveryObservation['task']['id'], state: 'running', updatedAt: initial },
    latestTaskId: 'task',
    executionActive: false,
    pendingApprovalCount: 0,
    events: [],
    now,
    ...overrides,
  };
}
function attempt(
  code: string,
  retryable = true,
): NonNullable<RecoveryObservation['latestAttempt']> {
  return {
    id: 'attempt' as NonNullable<RecoveryObservation['latestAttempt']>['id'],
    taskId: observation().task.id,
    state: 'failed',
    createdAt: initial,
    startedAt: initial,
    updatedAt: initial,
    failure: { code, message: 'Untrusted error text: auth token or quota speculation', retryable },
  };
}
function state(value: RecoveryObservation['task']['state']) {
  return { ...observation().task, state: value };
}

describe('read-only recovery diagnostics', () => {
  it.each(['running', 'failed', 'completed', 'cancelled'] as const)(
    'keeps review and push approvals separate from %s execution',
    (taskState) => {
      const result = diagnoseTaskRecovery(
        observation({
          task: state(taskState),
          executionActive: taskState === 'running',
          pendingApprovalCount: 2,
          pendingApprovals: { execution: 0, review: 1, push: 1 },
        }),
      );
      expect(result.reason).toBe(
        taskState === 'running'
          ? 'executing'
          : taskState === 'failed'
            ? 'execution_failed'
            : taskState === 'completed'
              ? 'execution_completed'
              : 'cancelled',
      );
      expect(result.pendingApprovals).toEqual({ execution: 0, review: 1, push: 1 });
      expect(result.automaticRetryAllowed).toBe(false);
    },
  );
  it('keeps real execution authorization visible alongside review approvals', () => {
    expect(
      diagnoseTaskRecovery(
        observation({
          executionActive: true,
          pendingApprovalCount: 3,
          pendingApprovals: { execution: 1, review: 1, push: 1 },
        }),
      ),
    ).toMatchObject({ reason: 'waiting_approval', actionOwner: 'operator' });
  });
  it.each<[RecoveryObservation['task']['state'], RecoveryReason]>([
    ['draft', 'awaiting_dispatch'],
    ['planning', 'awaiting_dispatch'],
    ['ready', 'awaiting_dispatch'],
    ['running', 'state_requires_inspection'],
    ['waiting', 'waiting_dependencies'],
    ['waiting_approval', 'state_requires_inspection'],
    ['blocked', 'blocked'],
    ['completed', 'execution_completed'],
    ['failed', 'execution_failed'],
    ['cancelled', 'cancelled'],
  ])('classifies inactive %s without starting work', (taskState, reason) => {
    expect(diagnoseTaskRecovery(observation({ task: state(taskState) }))).toMatchObject({
      reason,
      automaticRetryAllowed: false,
      executionActive: false,
    });
  });

  it.each([
    ['CONTROL_PLANE_RESTART', 'execution_interrupted'],
    ['ACP_CONNECTION_CLOSED', 'connection_lost'],
    ['AGENT_UPSTREAM_INTERNAL', 'upstream_failure'],
    ['ACP_TURN_INCOMPLETE', 'incomplete_turn'],
    ['EXECUTION_FAILED', 'execution_failed'],
    ['UNKNOWN_PROVIDER_ERROR', 'execution_failed'],
  ] as const)('classifies only canonical failure code %s', (code, reason) => {
    const result = diagnoseTaskRecovery(
      observation({ task: state('failed'), latestAttempt: attempt(code) }),
    );
    expect(result).toMatchObject({
      reason,
      nextAction: 'inspect_before_resume',
      automaticRetryAllowed: false,
      requiresWorkspaceInspection: true,
    });
    expect(JSON.stringify(result)).not.toContain('Untrusted error text');
  });

  it.each([true, false])('does not turn retryable=%s into automatic permission', (retryable) => {
    expect(
      diagnoseTaskRecovery(
        observation({
          task: state('failed'),
          latestAttempt: attempt('EXECUTION_FAILED', retryable),
        }),
      ).automaticRetryAllowed,
    ).toBe(false);
  });

  it('follows a newer round before considering old failures or approvals', () => {
    expect(
      diagnoseTaskRecovery(
        observation({
          task: state('failed'),
          latestTaskId: 'new-task',
          latestAttempt: attempt('ACP_CONNECTION_CLOSED'),
          pendingApprovalCount: 1,
        }),
      ),
    ).toMatchObject({ reason: 'newer_round_available', nextAction: 'read_latest_task' });
  });

  it('keeps active permission waits with the operator, not a retry loop', () => {
    expect(
      diagnoseTaskRecovery(observation({ executionActive: true, pendingApprovalCount: 2 })),
    ).toMatchObject({
      reason: 'waiting_approval',
      actionOwner: 'operator',
      pendingApprovalCount: 2,
      nextAction: 'review_approval',
    });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'waits for cleanup even when durable state is %s',
    (taskState) => {
      expect(
        diagnoseTaskRecovery(observation({ task: state(taskState), executionActive: true })),
      ).toMatchObject({
        reason: 'cleanup_in_progress',
        nextAction: 'wait',
        actionOwner: 'runtime',
      });
    },
  );

  it('does not diagnose a quiet active process as hung', () => {
    const result = diagnoseTaskRecovery(
      observation({ executionActive: true, now: now + 86_400_000 }),
    );
    expect(result.reason).toBe('executing');
    expect(result.inactivityMs).toBe(87_000_000);
    expect(result.automaticRetryAllowed).toBe(false);
  });

  it('does not claim acceptance merely because execution completed', () => {
    const result = diagnoseTaskRecovery(observation({ task: state('completed') }));
    expect(result.nextAction).toBe('verify_outputs');
    expect(result.instruction).toContain('not acceptance');
  });

  it('recognizes an interrupted attempt without inventing a completed task', () => {
    const latestAttempt = { ...attempt('CONTROL_PLANE_RESTART'), state: 'interrupted' as const };
    expect(diagnoseTaskRecovery(observation({ latestAttempt })).reason).toBe(
      'execution_interrupted',
    );
  });

  it('ignores attempts belonging to a different task', () => {
    const latestAttempt = {
      ...attempt('CONTROL_PLANE_RESTART'),
      taskId: 'other' as RecoveryObservation['task']['id'],
    };
    expect(diagnoseTaskRecovery(observation({ latestAttempt })).reason).toBe(
      'state_requires_inspection',
    );
  });

  it('filters query traffic, other tasks, stale attempts, old events and future timestamps', () => {
    const event = (
      type: string,
      occurredAt: string,
      attemptId?: string,
    ): RecoveryObservation['events'][number] => ({
      taskId: observation().task.id,
      type,
      occurredAt,
      payload: attemptId ? { attemptId } : {},
    });
    const result = diagnoseTaskRecovery(
      observation({
        latestAttempt: attempt('EXECUTION_FAILED'),
        events: [
          event('client.tool.called', '2026-10-24T12:09:59Z'),
          {
            ...event('agent.progress', '2026-10-24T12:09:00Z'),
            taskId: 'other' as RecoveryObservation['task']['id'],
          },
          event('agent.progress', '2026-10-24T12:08:00Z', 'old-attempt'),
          event('agent.progress', '2026-10-24T11:59:00Z'),
          event('agent.progress', '2026-10-24T13:00:00Z'),
          event('agent.progress', 'invalid'),
          event('agent.progress', '2026-10-24T12:02:00Z', 'attempt'),
        ],
      }),
    );
    expect(result.lastActivityAt).toBe('2026-10-24T12:02:00.000Z');
    expect(result.inactivityMs).toBe(480_000);
  });

  it('does not fabricate an activity time when no trustworthy timestamp is available', () => {
    expect(
      diagnoseTaskRecovery(observation({ task: { ...state('ready'), updatedAt: 'invalid' } })),
    ).toMatchObject({ lastActivityAt: null, inactivityMs: null });
  });

  it('returns deterministic output without changing the observation', () => {
    const input = observation({
      task: state('failed'),
      latestAttempt: attempt('EXECUTION_FAILED'),
    });
    const before = structuredClone(input);
    const first = diagnoseTaskRecovery(input);
    expect(diagnoseTaskRecovery(input)).toEqual(first);
    expect(input).toEqual(before);
  });

  it.each([NaN, Infinity])('rejects invalid observation time %s', (time) => {
    expect(() => diagnoseTaskRecovery(observation({ now: time }))).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN])('rejects invalid approval count %s', (count) => {
    expect(() => diagnoseTaskRecovery(observation({ pendingApprovalCount: count }))).toThrow(
      RangeError,
    );
  });
});
