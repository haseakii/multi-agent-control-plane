import type {
  AgentAuthMethodSummary,
  AgentReadiness,
  AgentRuntimeControl,
  AgentRuntimeObservation,
} from '@control-plane/acp-runtime';
import { AgentDefinitionSchema, ProjectSchema } from '@control-plane/core';
import type { AgentDefinition, AgentId, Project } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';

export type AgentRuntimeState = AgentRuntimeObservation & {
  error?: string | undefined;
};

export type RegisteredAgentView = {
  definition: AgentDefinition;
  readiness: AgentReadiness;
  authMethods: AgentAuthMethodSummary[];
  error?: string | undefined;
};

export class AgentControlError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentControlError';
  }
}

export type AgentControlServiceOptions = {
  now?: (() => string) | undefined;
};

export class AgentControlService {
  private readonly runtimeStates = new Map<AgentId, AgentRuntimeState>();
  private readonly now: () => string;

  constructor(
    private readonly storage: SqliteStorage,
    private readonly runtime: AgentRuntimeControl,
    options: AgentControlServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): RegisteredAgentView[] {
    return this.storage.repositories.agentDefinitions.list().map((definition) => ({
      definition,
      ...this.state(definition.id),
    }));
  }

  state(id: AgentId): AgentRuntimeState {
    const current = this.runtimeStates.get(id);
    if (current) {
      return structuredClone(current);
    }
    return {
      readiness: {
        runtime: 'unknown',
        auth: 'unknown',
        observedAt: this.now(),
        authMethodIds: [],
      },
      authMethods: [],
    };
  }

  create(input: unknown): RegisteredAgentView {
    const definition = AgentDefinitionSchema.parse(input);
    if (this.storage.repositories.agentDefinitions.get(definition.id)) {
      throw new AgentControlError(409, `Agent already exists: ${definition.id}`);
    }
    this.storage.repositories.agentDefinitions.upsert(definition);
    this.runtimeStates.delete(definition.id);
    return { definition, ...this.state(definition.id) };
  }

  update(id: string, input: unknown): RegisteredAgentView {
    const current = this.storage.repositories.agentDefinitions.get(id);
    if (!current) {
      throw new AgentControlError(404, `Agent not found: ${id}`);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AgentControlError(400, 'Agent patch must be an object.');
    }

    const patch = structuredClone(input as Record<string, unknown>);
    if (patch.id !== undefined && patch.id !== id) {
      throw new AgentControlError(400, 'Agent id cannot be changed.');
    }
    delete patch.id;

    const definition = AgentDefinitionSchema.parse({
      ...current,
      ...patch,
      id,
    });
    this.storage.repositories.agentDefinitions.upsert(definition);
    this.runtimeStates.delete(definition.id);
    return { definition, ...this.state(definition.id) };
  }

  async probe(id: string): Promise<RegisteredAgentView> {
    const definition = this.requireAgent(id);
    try {
      const observed = await this.runtime.probe(definition);
      this.runtimeStates.set(definition.id, structuredClone(observed));
    } catch {
      this.runtimeStates.set(definition.id, {
        readiness: {
          runtime: 'error',
          auth: 'unknown',
          observedAt: this.now(),
          authMethodIds: [],
        },
        authMethods: [],
        error: 'Agent probe failed.',
      });
    }
    return { definition, ...this.state(definition.id) };
  }

  async authenticate(id: string, methodId: string): Promise<RegisteredAgentView> {
    const definition = this.requireAgent(id);
    const method = this.state(definition.id).authMethods.find(
      (candidate) => candidate.id === methodId,
    );
    if (!method) {
      throw new AgentControlError(
        400,
        'Probe the agent first and choose an advertised authentication method.',
      );
    }
    if (method.type === 'terminal') {
      throw new AgentControlError(
        400,
        'Terminal authentication must be completed outside the control-plane API.',
      );
    }

    try {
      const observed = await this.runtime.authenticate(definition, methodId);
      this.runtimeStates.set(definition.id, structuredClone(observed));
      return { definition, ...this.state(definition.id) };
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new AgentControlError(400, error.message);
      }
      this.runtimeStates.set(definition.id, {
        readiness: {
          runtime: 'error',
          auth: 'unknown',
          observedAt: this.now(),
          authMethodIds: [],
        },
        authMethods: [],
        error: 'Agent authentication failed.',
      });
      throw new AgentControlError(502, 'Agent authentication failed.');
    }
  }

  selectBoss(projectId: string, agentId: string): Project {
    const project = this.storage.repositories.projects.get(projectId);
    if (!project) {
      throw new AgentControlError(404, `Project not found: ${projectId}`);
    }
    const agent = this.requireAgent(agentId);
    if (
      !agent.enabled ||
      !agent.orchestration.canBeBoss ||
      agent.controlBridge.transport !== 'mcp' ||
      !agent.controlBridge.scopes.includes('boss.orchestration')
    ) {
      throw new AgentControlError(
        400,
        'Selected agent is not eligible for the V0 Boss MCP bridge.',
      );
    }

    const updated = ProjectSchema.parse({
      ...project,
      defaultBossAgentId: agent.id,
      updatedAt: this.now(),
    });
    this.storage.repositories.projects.upsert(updated);
    return updated;
  }

  private requireAgent(id: string): AgentDefinition {
    const definition = this.storage.repositories.agentDefinitions.get(id);
    if (!definition) {
      throw new AgentControlError(404, `Agent not found: ${id}`);
    }
    return definition;
  }
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentControlError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ZodError'
  ) {
    return reply.code(400).send({ error: 'Request validation failed.' });
  }
  return reply.code(500).send({ error: 'Agent control request failed.' });
}

export function registerAgentControlRoutes(
  app: FastifyInstance,
  service: AgentControlService,
): void {
  app.get('/api/agents', async () => service.list());

  app.post('/api/agents', async (request, reply) => {
    try {
      return reply.code(201).send(service.create(request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/agents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return service.update(id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/agents/:id/probe', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await service.probe(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/agents/:id/auth', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { methodId?: unknown } | undefined;
      if (!body || typeof body.methodId !== 'string' || body.methodId.length === 0) {
        throw new AgentControlError(400, 'methodId is required.');
      }
      return await service.authenticate(id, body.methodId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put('/api/projects/:id/boss', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { agentId?: unknown } | undefined;
      if (!body || typeof body.agentId !== 'string' || body.agentId.length === 0) {
        throw new AgentControlError(400, 'agentId is required.');
      }
      return service.selectBoss(id, body.agentId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
