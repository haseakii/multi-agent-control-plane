import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentIdSchema, ProjectIdSchema } from '@control-plane/core';
import { openSqliteStorage } from '@control-plane/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageRouter, SqliteMessageRouterStore } from './index.js';

const tempDirectories: string[] = [];
let sequence = 0;

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-message-router-'));
  tempDirectories.push(directory);
  return join(directory, 'router.sqlite');
}

function createRouter(filename: string, now: () => string) {
  const storage = openSqliteStorage({ filename });
  const hooks = {
    authorize: vi.fn(async () => ({ allowed: true as const })),
    audit: vi.fn(async () => undefined),
  };
  const router = new MessageRouter(new SqliteMessageRouterStore(storage), {
    now,
    idFactory: (kind) => `${kind}-${++sequence}`,
    hooks,
    leaseMs: 1_000,
    retryDelayMs: 250,
  });
  return { storage, router, hooks };
}

const sender = {
  projectId: ProjectIdSchema.parse('project-messaging'),
  agentId: AgentIdSchema.parse('agent-a'),
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MessageRouter', () => {
  it('persists one idempotent A-to-B envelope and binds the authenticated sender', async () => {
    const filename = databasePath();
    const now = () => '2026-10-20T01:00:00.000Z';
    const { storage, router } = createRouter(filename, now);

    const first = await router.send(sender, {
      toAgentId: 'agent-b',
      type: 'request',
      content: 'Please review this.',
      idempotencyKey: 'request-1',
    });
    const duplicate = await router.send(sender, {
      toAgentId: 'agent-b',
      type: 'request',
      content: 'This body must not create a duplicate.',
      idempotencyKey: 'request-1',
    });

    expect(duplicate.message.id).toBe(first.message.id);
    expect(first.message.fromAgentId).toBe('agent-a');
    expect(first.message.toAgentId).toBe('agent-b');
    expect(storage.repositories.messages.list()).toHaveLength(1);
    expect(first.delivery.sequence).toBe(1);
    storage.close();
  });

  it('preserves FIFO mailbox ordering while the earlier message is in flight', async () => {
    const filename = databasePath();
    const now = () => '2026-10-20T01:01:00.000Z';
    const { storage, router } = createRouter(filename, now);

    const first = await router.send(sender, {
      toAgentId: 'agent-b',
      taskId: 'task-1',
      type: 'message',
      content: 'first',
    });
    const second = await router.send(sender, {
      toAgentId: 'agent-b',
      taskId: 'task-1',
      type: 'message',
      content: 'second',
    });

    const claim1 = await router.claimNext('agent-b');
    expect(claim1?.message.id).toBe(first.message.id);
    expect(await router.claimNext('agent-b')).toBeUndefined();

    await router.acknowledge(claim1!.delivery.id, claim1!.delivery.attemptCount);
    const claim2 = await router.claimNext('agent-b');
    expect(claim2?.message.id).toBe(second.message.id);
    expect(claim2?.delivery.sequence).toBe(2);
    storage.close();
  });

  it('retries a failed delivery after the configured delay without reordering the mailbox', async () => {
    const filename = databasePath();
    let current = '2026-10-20T01:01:30.000Z';
    const { storage, router } = createRouter(filename, () => current);

    const first = await router.send(sender, {
      toAgentId: 'agent-b',
      taskId: 'task-retry',
      type: 'message',
      content: 'retry me',
    });
    await router.send(sender, {
      toAgentId: 'agent-b',
      taskId: 'task-retry',
      type: 'message',
      content: 'wait behind the first',
    });

    const claim = await router.claimNext('agent-b');
    expect(claim?.message.id).toBe(first.message.id);
    await router.retry(
      claim!.delivery.id,
      claim!.delivery.attemptCount,
      'recipient temporarily unavailable',
    );

    expect(await router.claimNext('agent-b')).toBeUndefined();
    current = '2026-10-20T01:01:30.300Z';

    const retried = await router.claimNext('agent-b');
    expect(retried?.message.id).toBe(first.message.id);
    expect(retried?.delivery.attemptCount).toBe(2);
    storage.close();
  });

  it('redelivers an unacknowledged message after restart and lease expiry', async () => {
    const filename = databasePath();
    let current = '2026-10-20T01:02:00.000Z';
    const first = createRouter(filename, () => current);

    const sent = await first.router.send(sender, {
      toAgentId: 'agent-b',
      type: 'handoff',
      content: 'Take over this work.',
    });
    const claimed = await first.router.claimNext('agent-b');
    expect(claimed?.delivery.attemptCount).toBe(1);
    first.storage.close();

    current = '2026-10-20T01:02:02.000Z';
    const second = createRouter(filename, () => current);
    expect(second.router.recoverExpired()).toBe(1);

    const redelivered = await second.router.claimNext('agent-b');
    expect(redelivered?.message.id).toBe(sent.message.id);
    expect(redelivered?.delivery.attemptCount).toBe(2);
    second.storage.close();
  });

  it('fences stale acknowledgements and retries after a restarted consumer reclaims the lease', async () => {
    const filename = databasePath();
    let current = '2026-10-20T01:04:00.000Z';
    const first = createRouter(filename, () => current);
    await first.router.send(sender, {
      toAgentId: 'agent-b',
      type: 'response',
      content: 'A durable worker result.',
    });
    const stale = (await first.router.claimNext('agent-b'))!;
    const second = createRouter(filename, () => current);
    try {
      current = '2026-10-20T01:04:02.000Z';
      expect(second.router.recoverExpired()).toBe(1);
      const reclaimed = (await second.router.claimNext('agent-b'))!;
      expect(reclaimed.delivery.attemptCount).toBe(stale.delivery.attemptCount + 1);

      await expect(
        first.router.acknowledge(stale.delivery.id, stale.delivery.attemptCount),
      ).rejects.toMatchObject({ code: 'STALE_DELIVERY_CLAIM' });
      await expect(
        first.router.retry(stale.delivery.id, stale.delivery.attemptCount, 'Late failure'),
      ).rejects.toMatchObject({ code: 'STALE_DELIVERY_CLAIM' });
      expect(
        new SqliteMessageRouterStore(second.storage).getDelivery(stale.delivery.id),
      ).toMatchObject({ state: 'delivering', attemptCount: reclaimed.delivery.attemptCount });

      await second.router.acknowledge(reclaimed.delivery.id, reclaimed.delivery.attemptCount);
      // Same-generation ACK is idempotent, but an old consumer must still fail.
      await second.router.acknowledge(reclaimed.delivery.id, reclaimed.delivery.attemptCount);
      await expect(
        first.router.acknowledge(stale.delivery.id, stale.delivery.attemptCount),
      ).rejects.toMatchObject({ code: 'STALE_DELIVERY_CLAIM' });
      expect(await second.router.claimNext('agent-b')).toBeUndefined();
    } finally {
      second.storage.close();
      first.storage.close();
    }
  });

  it('renews only a live generation, then recovers after renewal stops', async () => {
    let current = '2026-10-20T01:10:00.000Z';
    const { storage, router } = createRouter(':memory:', () => current);
    try {
      await router.send(sender, { toAgentId: 'agent-b', type: 'message', content: 'long work' });
      const first = (await router.claimNext('agent-b'))!;
      for (let tick = 1; tick <= 5; tick++) {
        current = new Date(Date.parse('2026-10-20T01:10:00.000Z') + tick * 500).toISOString();
        router.renewClaim(first.delivery.id, first.delivery.attemptCount);
        expect(router.recoverExpired()).toBe(0);
      }
      current = '2026-10-20T01:10:04.000Z';
      // Even if recovery has not run yet, an expired owner cannot revive itself.
      expect(() => router.renewClaim(first.delivery.id, first.delivery.attemptCount)).toThrow();
      expect(router.recoverExpired()).toBe(1);
      const next = (await router.claimNext('agent-b'))!;
      expect(() => router.renewClaim(first.delivery.id, first.delivery.attemptCount)).toThrowError(
        expect.objectContaining({ code: 'STALE_DELIVERY_CLAIM' }),
      );
      router.renewClaim(next.delivery.id, next.delivery.attemptCount);
      await router.acknowledge(next.delivery.id, next.delivery.attemptCount);
    } finally {
      storage.close();
    }
  });

  it('preserves correlation and reply chains without routing through a Boss', async () => {
    const filename = databasePath();
    const now = () => '2026-10-20T01:03:00.000Z';
    const { storage, router } = createRouter(filename, now);

    const request = await router.send(sender, {
      toAgentId: 'agent-b',
      type: 'request',
      content: 'Need help.',
    });
    const response = await router.send(
      {
        projectId: sender.projectId,
        agentId: AgentIdSchema.parse('agent-b'),
      },
      {
        toAgentId: 'agent-a',
        type: 'response',
        replyTo: request.message.id,
        content: 'Done.',
      },
    );

    expect(response.message.replyTo).toBe(request.message.id);
    expect(response.message.correlationId).toBe(request.message.id);
    expect(response.message.fromAgentId).toBe('agent-b');
    storage.close();
  });
});
