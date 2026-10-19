import type { AgentDefinition, AgentId } from './types.js';

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

function assertDefinition(definition: AgentDefinition): void {
  if (definition.id.trim().length === 0) {
    throw new TypeError('Agent id must not be empty.');
  }
  if (definition.name.trim().length === 0) {
    throw new TypeError('Agent name must not be empty.');
  }
  if (definition.runtime.command.trim().length === 0) {
    throw new TypeError('ACP stdio command must not be empty.');
  }
  if (definition.auth.mode === 'secret-ref' && !definition.auth.secretRef) {
    throw new TypeError('secret-ref auth requires secretRef.');
  }
}

export class InMemoryAgentRegistry {
  private readonly definitions = new Map<AgentId, AgentDefinition>();

  create(definition: AgentDefinition): AgentDefinition {
    assertDefinition(definition);
    if (this.definitions.has(definition.id)) {
      throw new AgentAlreadyExistsError(definition.id);
    }

    const stored = cloneDefinition(definition);
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
    const next: AgentDefinition = {
      ...current,
      ...structuredClone(update),
      id,
    };
    assertDefinition(next);
    this.definitions.set(id, cloneDefinition(next));
    return cloneDefinition(next);
  }

  delete(id: AgentId): void {
    if (!this.definitions.delete(id)) {
      throw new AgentNotFoundError(id);
    }
  }
}
