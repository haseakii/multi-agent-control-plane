import { AgentDefinitionSchema } from '@control-plane/core';
import type { AgentDefinition, AgentId } from '@control-plane/core';

export class AgentAlreadyExistsError extends Error {
  constructor(id: AgentId) {
    super(`Agent definition already exists: ${id}`);
    this.name = 'AgentAlreadyExistsError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(id: AgentId) {
    super(`Agent definition not found: ${id}`);
    this.name = 'AgentNotFoundError';
  }
}

function cloneDefinition(definition: AgentDefinition): AgentDefinition {
  return structuredClone(definition);
}

export class InMemoryAgentRegistry {
  private readonly definitions = new Map<AgentId, AgentDefinition>();

  create(definition: AgentDefinition): AgentDefinition {
    const parsed = AgentDefinitionSchema.parse(definition);
    if (this.definitions.has(parsed.id)) {
      throw new AgentAlreadyExistsError(parsed.id);
    }

    const stored = cloneDefinition(parsed);
    this.definitions.set(stored.id, stored);
    return cloneDefinition(stored);
  }

  get(id: AgentId): AgentDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new AgentNotFoundError(id);
    }
    return cloneDefinition(definition);
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()]
      .map(cloneDefinition)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  update(id: AgentId, update: Partial<Omit<AgentDefinition, 'id'>>): AgentDefinition {
    const current = this.get(id);
    const next = AgentDefinitionSchema.parse({
      ...current,
      ...structuredClone(update),
      id,
    });
    this.definitions.set(id, cloneDefinition(next));
    return cloneDefinition(next);
  }

  delete(id: AgentId): void {
    if (!this.definitions.delete(id)) {
      throw new AgentNotFoundError(id);
    }
  }
}
