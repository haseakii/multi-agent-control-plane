import { describe, expect, it } from 'vitest';
import { AgentNotFoundError, InMemoryAgentRegistry } from './registry.js';
import type { AgentDefinition } from './types.js';

function definition(id: string, command: string): AgentDefinition {
  return {
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
  };
}

describe('InMemoryAgentRegistry', () => {
  it('registers two distinct ACP agent definitions without vendor-specific role fields', () => {
    const registry = new InMemoryAgentRegistry();

    registry.create(definition('agent-a', 'agent-a-acp'));
    registry.create(definition('agent-b', 'agent-b-acp'));

    expect(registry.list().map((agent) => agent.id)).toEqual(['agent-a', 'agent-b']);
    expect(registry.get('agent-a').runtime.type).toBe('acp-stdio');
  });

  it('updates and deletes definitions through immutable snapshots', () => {
    const registry = new InMemoryAgentRegistry();
    const created = registry.create(definition('agent-a', 'agent-a-acp'));
    created.name = 'mutated outside registry';

    expect(registry.get('agent-a').name).toBe('agent-a');

    registry.update('agent-a', { name: 'Agent A' });
    expect(registry.get('agent-a').name).toBe('Agent A');

    registry.delete('agent-a');
    expect(() => registry.get('agent-a')).toThrow(AgentNotFoundError);
  });
});
