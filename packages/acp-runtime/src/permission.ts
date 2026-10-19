import type { PermissionBroker, PermissionDecision, PermissionRequest } from './types.js';

export class DenyByDefaultPermissionBroker implements PermissionBroker {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return { outcome: 'cancelled' };
  }
}
