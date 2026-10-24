import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import { describe, expect, it } from 'vitest';
import { CapabilitySelector } from './capability-selector.js';
import { InMemoryAgentRegistry } from './registry.js';
import type { AgentReadiness } from './types.js';

const ready: AgentReadiness = {
  runtime: 'ready',
  auth: 'ready',
  observedAt: '2026-10-19T09:00:00Z',
  authMethodIds: [],
};

function definition(
  id: string,
  capabilities: Array<{ name: string; source: 'configured' | 'advertised' | 'verified' }>,
  enabled = true,
) {
  return AgentDefinitionSchema.parse({
    id,
    name: id,
    enabled,
    runtime: { type: 'acp-stdio', command: id, args: [] },
    capabilities,
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
}

describe('CapabilitySelector', () => {
  it('registers capabilities and selects ready, enabled, policy-eligible agents by exact and prefix match', () => {
    const registry = new InMemoryAgentRegistry();
    registry.create(
      definition('agent-a', [
        { name: 'code.read', source: 'configured' },
        { name: 'unity.editor', source: 'verified' },
      ]),
    );
    registry.create(
      definition('agent-b', [
        { name: 'code.read', source: 'configured' },
        { name: 'unity.test', source: 'advertised' },
        { name: 'unity.build', source: 'verified' },
      ]),
    );
    registry.create(
      definition('agent-disabled', [{ name: 'code.read', source: 'configured' }], false),
    );
    registry.create(definition('agent-needs-login', [{ name: 'code.read', source: 'configured' }]));
    registry.create(
      definition('agent-policy-denied', [{ name: 'code.read', source: 'configured' }]),
    );

    const readiness = new Map<string, AgentReadiness>([
      ['agent-a', ready],
      ['agent-b', ready],
      ['agent-disabled', ready],
      ['agent-needs-login', { ...ready, auth: 'needs_login' }],
      ['agent-policy-denied', ready],
    ]);
    const selector = new CapabilitySelector(registry, {
      getReadiness: (id) => readiness.get(id),
      policyAllows: (agent) => agent.id !== AgentIdSchema.parse('agent-policy-denied'),
    });

    const selected = selector.select({ exact: ['code.read'], prefixes: ['unity.'] });

    expect(selected.map((result) => result.agent.id)).toEqual(['agent-b', 'agent-a']);
    expect(selected[0]?.matchedExact).toEqual(['code.read']);
    expect(selected[0]?.matchedPrefixes).toEqual(['unity.']);
    expect(selected[0]?.matchedCapabilities.map((capability) => capability.name)).toEqual([
      'code.read',
      'unity.test',
      'unity.build',
    ]);
    expect(selected[0]?.score).toBe(3);
    expect(selected.every((result) => result.readiness.runtime === 'ready')).toBe(true);
    const initial = selector.select({});
    expect(initial.map((result) => result.agent.id)).toEqual(['agent-b', 'agent-a']);
    expect(initial[0]?.matchedCapabilities.map((capability) => capability.name)).toEqual([
      'code.read',
      'unity.test',
      'unity.build',
    ]);
  });

  it('supports custom capability queries and limits while returning deterministic metadata', () => {
    const registry = new InMemoryAgentRegistry();
    registry.create(definition('agent-z', [{ name: 'code.review', source: 'verified' }]));
    registry.create(definition('agent-a', [{ name: 'security.audit', source: 'verified' }]));
    const selector = new CapabilitySelector(registry, {
      getReadiness: () => ready,
      policyAllows: () => true,
      customCapabilityMatcher: (capability, query) =>
        query === 'verified-only' && capability.source === 'verified',
    });

    const selected = selector.select({ custom: 'verified-only', limit: 1 });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.agent.id).toBe('agent-a');
    expect(selected[0]?.customQueryMatched).toBe(true);
    expect(selected[0]?.matchedCapabilities).toEqual([
      { name: 'security.audit', source: 'verified' },
    ]);
  });

  it('allows capability registration to be updated idempotently and removed', () => {
    const registry = new InMemoryAgentRegistry();
    registry.create(definition('agent-a', [{ name: 'code.read', source: 'configured' }]));
    const selector = new CapabilitySelector(registry, {
      getReadiness: () => ready,
      policyAllows: () => true,
    });
    const id = AgentIdSchema.parse('agent-a');

    selector.registerCapability(id, { name: 'code.write', source: 'advertised' });
    selector.registerCapability(id, { name: 'code.write', source: 'verified' });
    expect(registry.get(id).capabilities).toContainEqual({
      name: 'code.write',
      source: 'verified',
    });

    selector.unregisterCapability(id, 'code.write');
    expect(registry.get(id).capabilities.map((capability) => capability.name)).toEqual([
      'code.read',
    ]);
  });

  it('requires a custom matcher and returns an empty list for an empty registry', () => {
    const registry = new InMemoryAgentRegistry();
    const selector = new CapabilitySelector(registry, {
      getReadiness: () => ready,
      policyAllows: () => true,
    });

    expect(() => selector.select({ custom: 'anything' })).toThrow(
      'A customCapabilityMatcher is required',
    );
    expect(selector.select({})).toEqual([]);
  });
});
