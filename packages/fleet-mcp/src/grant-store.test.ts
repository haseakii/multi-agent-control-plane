import { AgentIdSchema } from '@control-plane/core';
import { describe, expect, it } from 'vitest';
import { FleetBridgeGrantError, InMemoryFleetBridgeGrantStore } from './grant-store.js';

describe('InMemoryFleetBridgeGrantStore', () => {
  it('issues opaque grants, binds sessions, resolves identity, and revokes', async () => {
    let now = new Date('2026-10-20T05:00:00.000Z');
    const store = new InMemoryFleetBridgeGrantStore({
      ttlMs: 60_000,
      now: () => now,
      tokenFactory: () => 'opaque-grant-token',
    });

    const grant = await store.issue({
      agentId: AgentIdSchema.parse('boss-agent'),
      projectId: 'project-1',
      taskId: 'task-1',
      scopes: ['boss.orchestration', 'artifact.read'],
    });

    expect(grant.token).toBe('opaque-grant-token');
    expect(store.resolve(grant.token)).toMatchObject({
      agentId: 'boss-agent',
      projectId: 'project-1',
      taskId: 'task-1',
      scopes: ['boss.orchestration', 'artifact.read'],
    });

    await store.bindSession(grant.token, 'session-1');
    expect(store.resolve(grant.token).sessionId).toBe('session-1');
    await expect(store.bindSession(grant.token, 'session-2')).rejects.toThrow(
      'already bound',
    );

    await store.revoke(grant.token);
    expect(() => store.resolve(grant.token)).toThrow(FleetBridgeGrantError);

    now = new Date('2026-10-20T05:02:00.000Z');
  });

  it('rejects expired grants without storing the raw token as a lookup key', async () => {
    let now = new Date('2026-10-20T05:00:00.000Z');
    const store = new InMemoryFleetBridgeGrantStore({
      ttlMs: 1_000,
      now: () => now,
      tokenFactory: () => 'expires-fast',
    });
    const grant = await store.issue({
      agentId: AgentIdSchema.parse('boss-agent'),
      projectId: 'project-1',
      scopes: ['boss.orchestration'],
    });

    now = new Date('2026-10-20T05:00:02.000Z');
    expect(() => store.resolve(grant.token)).toThrow('expired');
  });
});
