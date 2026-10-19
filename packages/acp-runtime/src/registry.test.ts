import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import { describe, expect, it } from 'vitest';
import { AgentNotFoundError, InMemoryAgentRegistry } from './registry.js';
import type { AgentDefinition } from './types.js';

function definition(id: string, command: string): AgentDefinition {
  return AgentDefinitionSchema.parse({
    id,
    name: id,
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command,
      args: [],
    },
    capabilities: [{ name: 'code.read', source: 'configured' }],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
}

describe('InMemoryAgentRegistry', () => {
  it('registers two distinct ACP agent definitions without vendor-specific role fields', () => {
    const registry = new InMemoryAgentRegistry();
    const agentA = AgentIdSchema.parse('agent-a');

    registry.create(definition('agent-a', 'agent-a-acp'));
    registry.create(definition('agent-b', 'agent-b-acp'));

    expect(registry.list().map((agent) => agent.id)).toEqual(['agent-a', 'agent-b']);
    expect(registry.get(agentA).runtime.type).toBe('acp-stdio');
  });

  it('updates and deletes definitions through immutable snapshots', () => {
    const registry = new InMemoryAgentRegistry();
    const agentA = AgentIdSchema.parse('agent-a');
    const created = registry.create(definition('agent-a', 'agent-a-acp'));
    created.name = 'mutated outside registry';

    expect(registry.get(agentA).name).toBe('agent-a');

    registry.update(agentA, { name: 'Agent A' });
    expect(registry.get(agentA).name).toBe('Agent A');

    registry.delete(agentA);
    expect(() => registry.get(agentA)).toThrow(AgentNotFoundError);
  });
});
