import { describe, expect, it } from 'vitest';
import { DenyByDefaultPermissionBroker } from './permission.js';

describe('DenyByDefaultPermissionBroker', () => {
  it('never auto-approves permission requests', async () => {
    const broker = new DenyByDefaultPermissionBroker();

    await expect(
      broker.decide({
        sessionId: 'session-1',
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        subject: { toolCallId: 'call-1' },
      }),
    ).resolves.toEqual({ outcome: 'cancelled' });
  });
});
