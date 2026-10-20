import { ApprovalIdSchema, ApprovalSchema } from '@control-plane/core';
import type { Approval } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import {
  ApprovalNotFoundError,
  type ApprovalServiceOptions,
  type ApprovalStore,
  type ApprovalWaitOptions,
  type ParsedPolicyRequest,
  type PolicyDecision,
} from './types.js';

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly storage: SqliteStorage) {}

  save(approval: Approval): Approval {
    return this.storage.repositories.approvals.upsert(approval);
  }

  get(id: string): Approval | undefined {
    return this.storage.repositories.approvals.get(id);
  }

  listPending(projectId?: string): Approval[] {
    return this.storage.repositories.approvals
      .list()
      .filter(
        (approval) =>
          approval.state === 'pending' &&
          (projectId === undefined || approval.projectId === projectId),
      )
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Approval wait aborted.'));
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error('Approval wait aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal) {
      timeout[Symbol.dispose] = () => signal.removeEventListener('abort', onAbort);
    }
  });
}

export class ApprovalService {
  private readonly pollIntervalMs: number;

  constructor(
    readonly store: ApprovalStore,
    private readonly options: ApprovalServiceOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  request(request: ParsedPolicyRequest, decision: PolicyDecision): Approval {
    if (decision.effect !== 'ask') {
      throw new TypeError('Only ask decisions create approvals.');
    }
    return this.store.save(
      ApprovalSchema.parse({
        id: ApprovalIdSchema.parse(this.options.idFactory()),
        projectId: request.projectId,
        taskId: request.taskId,
        requesterAgentId: request.requesterAgentId,
        assignmentId: request.assignmentId,
        action: request.action,
        resource: request.resource,
        policyRuleId: decision.ruleId,
        enforcementMode: request.enforcementMode,
        boundary: request.boundary,
        state: 'pending',
        requestedAt: this.options.now(),
      }),
    );
  }

  resolve(id: string, state: 'approved' | 'rejected', actor: string): Approval {
    const approval = this.require(id);
    if (approval.state !== 'pending') {
      return approval;
    }
    return this.store.save(
      ApprovalSchema.parse({
        ...approval,
        state,
        decidedAt: this.options.now(),
        decisionActor: actor,
      }),
    );
  }

  expire(id: string, actor = 'system'): Approval {
    const approval = this.require(id);
    if (approval.state !== 'pending') {
      return approval;
    }
    return this.store.save(
      ApprovalSchema.parse({
        ...approval,
        state: 'expired',
        decidedAt: this.options.now(),
        decisionActor: actor,
      }),
    );
  }

  get(id: string): Approval {
    return this.require(id);
  }

  listPending(projectId?: string): Approval[] {
    return this.store.listPending(projectId);
  }

  async waitForDecision(id: string, options: ApprovalWaitOptions = {}): Promise<Approval> {
    const interval = options.pollIntervalMs ?? this.pollIntervalMs;
    for (;;) {
      const approval = this.require(id);
      if (approval.state !== 'pending') {
        return approval;
      }
      await sleep(interval, options.signal);
    }
  }

  private require(id: string): Approval {
    const approvalId = ApprovalIdSchema.parse(id);
    const approval = this.store.get(approvalId);
    if (!approval) {
      throw new ApprovalNotFoundError(id);
    }
    return approval;
  }
}
