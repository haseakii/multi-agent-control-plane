import {
  ApprovalRejectedError,
  PolicyDeniedError,
  PolicyRequestSchema,
  type ApprovalWaitOptions,
  type PolicyAuthorization,
  type PolicyRequest,
} from './types.js';
import type { ApprovalService } from './approval-service.js';
import type { PolicyEngine } from './policy-engine.js';

export class PolicyGate {
  constructor(
    readonly engine: PolicyEngine,
    readonly approvals: ApprovalService,
  ) {}

  authorize(input: PolicyRequest): PolicyAuthorization {
    const request = PolicyRequestSchema.parse(input);
    const decision = this.engine.evaluate(request);
    if (decision.effect === 'deny') {
      throw new PolicyDeniedError(decision);
    }
    if (decision.effect === 'allow') {
      return { status: 'allowed', decision };
    }

    const approval = this.approvals.request(request, decision);
    return { status: 'approval_required', decision, approval };
  }

  async run<T>(
    request: PolicyRequest,
    operation: () => Promise<T> | T,
    waitOptions: ApprovalWaitOptions = {},
  ): Promise<T> {
    const authorization = this.authorize(request);
    if (authorization.status === 'approval_required') {
      const resolved = await this.approvals.waitForDecision(authorization.approval.id, waitOptions);
      if (resolved.state !== 'approved') {
        throw new ApprovalRejectedError(resolved);
      }
    }
    return operation();
  }
}
