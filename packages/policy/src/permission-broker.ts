import type {
  PermissionBroker,
  PermissionDecision,
  PermissionRequest,
} from '@control-plane/acp-runtime';
import type { PolicyGate } from './policy-gate.js';
import {
  ApprovalRejectedError,
  PolicyDeniedError,
  type PolicyRequest,
} from './types.js';

export type AcpPermissionPolicyMapper = (request: PermissionRequest) => PolicyRequest;
export type AcpPermissionOptionSelector = (request: PermissionRequest) => string | undefined;

export function selectFirstAllowOption(request: PermissionRequest): string | undefined {
  return request.options.find((option) => {
    const marker = `${option.kind ?? ''} ${option.name}`.toLowerCase();
    return marker.includes('allow');
  })?.optionId;
}

export class PolicyPermissionBroker implements PermissionBroker {
  constructor(
    private readonly gate: PolicyGate,
    private readonly mapRequest: AcpPermissionPolicyMapper,
    private readonly selectOption: AcpPermissionOptionSelector = selectFirstAllowOption,
  ) {}

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const optionId = this.selectOption(request);
    if (!optionId) {
      return { outcome: 'cancelled' };
    }

    try {
      await this.gate.run(this.mapRequest(request), async () => undefined);
      return { outcome: 'selected', optionId };
    } catch (error) {
      if (error instanceof PolicyDeniedError || error instanceof ApprovalRejectedError) {
        return { outcome: 'cancelled' };
      }
      throw error;
    }
  }
}
