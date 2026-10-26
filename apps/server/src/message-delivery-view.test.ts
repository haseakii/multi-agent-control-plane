import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { AgentMessageSchema } from '@control-plane/core';
import { SqliteMessageRouterStore } from '@control-plane/message-router';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { readControlCenterSnapshot } from './control-center.js';
import { buildServer } from './server.js';

it('exposes durable delivery receipts and task navigation without claiming or replaying work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'message-view-')),
    filename = join(root, 'state.sqlite');
  let storage = openSqliteStorage({ filename });
  const options = () => ({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  let runtime = createControlPlaneRuntime(options()),
    app = buildServer({ taskControl: runtime });
  try {
    runtime.createProject({ id: 'p', name: 'Messages' });
    runtime.createProject({ id: 'other', name: 'Other' });
    runtime.taskEngine.createTask({
      id: 'sender',
      projectId: 'p',
      title: 'Request owner',
      objective: 'Request',
      state: 'running',
    });
    runtime.taskEngine.createTask({
      id: 'recipient',
      projectId: 'p',
      title: 'Recipient',
      objective: 'Answer',
      state: 'running',
    });
    runtime.taskEngine.createTask({
      id: 'foreign',
      projectId: 'other',
      title: 'Foreign',
      objective: 'Other',
      state: 'running',
    });
    const message = storage.repositories.messages.upsert(
      AgentMessageSchema.parse({
        id: 'message-request',
        projectId: 'p',
        taskId: 'sender',
        fromAgentId: 'a',
        toAgentId: 'b',
        type: 'request',
        content: 'Please review.',
        artifactRefs: [],
        metadata: { recipientTaskId: 'foreign' },
        createdAt: '2020-01-01T00:00:00Z',
      }),
    );
    const store = new SqliteMessageRouterStore(storage);
    store.enqueueDelivery({
      id: 'delivery-request',
      messageId: message.id,
      projectId: 'p',
      recipientAgentId: 'b',
      mailboxKey: 'task:recipient:agent:b',
      availableAt: '2020-01-01T00:00:00Z',
    });
    const url = '/api/tasks/sender/message-deliveries';
    const queued = (await app.inject({ method: 'GET', url })).json();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      state: 'pending',
      reason: 'queued',
      recipientTaskId: 'recipient',
      attemptCount: 0,
    });
    expect(queued[0]).not.toHaveProperty('mailboxKey');
    storage.repositories.tasks.upsert({
      ...storage.repositories.tasks.get('recipient')!,
      state: 'waiting_approval',
    });
    expect((await app.inject({ method: 'GET', url })).json()[0].reason).toBe('recipient_approval');
    storage.repositories.tasks.upsert({
      ...storage.repositories.tasks.get('recipient')!,
      state: 'failed',
    });
    expect((await app.inject({ method: 'GET', url })).json()[0].reason).toBe('recipient_stopped');
    storage.repositories.tasks.upsert({
      ...storage.repositories.tasks.get('recipient')!,
      state: 'running',
    });
    const claimed = store.claimNext({
      recipientAgentId: 'b',
      mailboxKey: 'task:recipient:agent:b',
      now: '2020-01-01T00:00:00Z',
      leaseUntil: '2020-01-01T00:01:00Z',
    })!;
    const before = store.getDelivery(claimed.id);
    const snapshot = readControlCenterSnapshot(storage);
    expect(snapshot.messageDeliveries?.[0]).toMatchObject({
      state: 'delivering',
      reason: 'lease_expired',
      attemptCount: 1,
    });
    expect(store.getDelivery(claimed.id)).toEqual(before); // Reading expired state never reclaims it.
    const delivered = store.markDelivered(claimed.id, claimed.attemptCount, '2020-01-01T00:00:30Z');
    expect((await app.inject({ method: 'GET', url })).json()[0]).toMatchObject({
      state: 'delivered',
      reason: 'acknowledged',
      deliveredAt: delivered.deliveredAt,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/tasks/foreign/message-deliveries' })).json(),
    ).toEqual([]);
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime });
    expect((await app.inject({ method: 'GET', url })).json()[0]).toMatchObject({
      state: 'delivered',
      reason: 'acknowledged',
      attemptCount: 1,
      recipientTaskId: 'recipient',
    });
    expect(storage.repositories.executionAttempts.list()).toEqual([]);
    expect(storage.repositories.messages.list()).toHaveLength(1);
  } finally {
    await runtime.close();
    await app.close();
    if (storage.sqlite.open) storage.close();
    const target = resolve(root);
    if (!relative(resolve(tmpdir()), target).startsWith('message-view-'))
      throw Error('Unexpected fixture directory');
    rmSync(target, { recursive: true, force: true });
  }
});
