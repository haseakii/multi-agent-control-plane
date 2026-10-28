import { inspectAgentConfiguration } from '@control-plane/runner';
import { detectInstalledAgentCLIs } from './agent-auto-discovery.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentConnectionFailure } from '@control-plane/acp-runtime';
import type {
  AgentAuthMethodSummary,
  AgentReadiness,
  AgentRuntimeControl,
  AgentRuntimeObservation,
} from '@control-plane/acp-runtime';
import {
  AgentDefinitionSchema,
  ProjectSchema,
  AgentIdSchema,
  AgentRemovalPreviewSchema,
  RemoveAgentInputSchema,
  SelectProjectBossInputSchema,
  AgentCatalogSourceInputSchema,
  AgentCatalogSourceViewSchema,
} from '@control-plane/core';
import type {
  AgentDefinition,
  AgentId,
  Project,
  AgentCatalogSourceInput,
  AgentCatalogSourceView,
} from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import {
  SqliteAgentCatalogSourcesRepository,
  AgentCatalogSourceConflictError,
  type AgentCatalogSourcesRepository,
} from '@control-plane/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';

export type AgentRuntimeState = AgentRuntimeObservation & {
  connectionOperation?: 'probe' | 'auth' | undefined;
  definitionHash?: string;
  error?: string | undefined;
  localEntry?: { offlineChecksPassed: boolean; issues: Array<{ code: string; message: string }> };
  registrationSource?: AgentCatalogSourceView;
};

export type RegisteredAgentView = {
  connectionOperation?: 'probe' | 'auth' | undefined;
  definitionHash?: string;
  definition: AgentDefinition;
  readiness: AgentReadiness;
  authMethods: AgentAuthMethodSummary[];
  error?: string | undefined;
  localEntry?: AgentRuntimeState['localEntry'];
  registrationSource?: AgentCatalogSourceView;
};

export class AgentControlError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AgentControlError';
  }
}

export type AgentControlServiceOptions = {
  now?: (() => string) | undefined;
  catalogSources?: AgentCatalogSourcesRepository;
};

function definitionHash(definition: AgentDefinition) {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function connectionFingerprint(definition: AgentDefinition | undefined) {
  if (!definition) return undefined;
  // Labels and discovery hints do not change the process, account or authority.
  // Every other field remains part of observation invalidation.
  const {
    name: _name,
    description: _description,
    capabilities: _capabilities,
    ...connection
  } = definition;
  return JSON.stringify(connection);
}

export class AgentControlService {
  private readonly runtimeStates = new Map<AgentId, AgentRuntimeState>();
  private readonly now: () => string;
  private readonly catalogSources: AgentCatalogSourcesRepository;
  private readonly configurationGenerations = new Map<string, number>();
  private readonly requestGenerations = new Map<string, number>();
  private readonly observationsInFlight = new Map<string, number>();
  private readonly authenticationsInFlight = new Set<string>();

  private beginObservation(definition: AgentDefinition): () => boolean {
    const id = definition.id;
    this.observationsInFlight.set(id, (this.observationsInFlight.get(id) ?? 0) + 1);
    const configuration = this.configurationGenerations.get(id) ?? 0;
    const request = (this.requestGenerations.get(id) ?? 0) + 1;
    this.requestGenerations.set(id, request);
    const fingerprint = connectionFingerprint(definition);
    return () =>
      (this.configurationGenerations.get(id) ?? 0) === configuration &&
      this.requestGenerations.get(id) === request &&
      connectionFingerprint(this.storage.repositories.agentDefinitions.get(id)) === fingerprint;
  }

  private currentView(id: string): RegisteredAgentView {
    const definition = this.requireAgent(id);
    return { definition, ...this.state(definition.id) };
  }

  private endObservation(id: string) {
    const count = (this.observationsInFlight.get(id) ?? 1) - 1;
    if (count > 0) this.observationsInFlight.set(id, count);
    else this.observationsInFlight.delete(id);
  }

  removalPreview(rawId: string) {
    const agentId = AgentIdSchema.parse(rawId);
    const definition = this.requireAgent(agentId);
    const references = this.storage.repositories.agentReferences.list(agentId);
    const blockers = [
      ...(definition.enabled ? ['enabled'] : []),
      ...(references.length ? ['referenced'] : []),
      ...(this.observationsInFlight.has(agentId) ? ['observation-in-progress'] : []),
    ];
    return AgentRemovalPreviewSchema.parse({
      agentId,
      name: definition.name,
      definitionHash: definitionHash(definition),
      checkedAt: this.now(),
      canRemove: blockers.length === 0,
      blockers,
      references,
    });
  }

  /** Program removal preserves historical members; only live use blocks filesystem cleanup. */
  programRemovalBlockers(rawId: string): string[] {
    const agent = this.requireAgent(rawId);
    const owned = this.storage.repositories.assignments
      .list()
      .filter((item) => item.agentId === agent.id);
    const assignments = new Set(owned.map((item) => item.id));
    return [
      ...(agent.enabled ? ['请先停用成员'] : []),
      ...(this.observationsInFlight.has(agent.id) ? ['正在检查连接或登录'] : []),
      ...(owned.some((item) => ['queued', 'running', 'waiting'].includes(item.state)) ||
      this.storage.repositories.executionAttempts
        .list()
        .some(
          (attempt) =>
            assignments.has(attempt.assignmentId) &&
            ['queued', 'running', 'waiting'].includes(attempt.state),
        )
        ? ['仍有排队或运行中的任务']
        : []),
    ];
  }

  remove(id: string, raw: unknown) {
    const input = RemoveAgentInputSchema.parse(raw);
    return this.storage.repositories.transaction(() => {
      const preview = this.removalPreview(id);
      if (
        input.confirmedAgentId !== preview.agentId ||
        input.definitionHash !== preview.definitionHash
      )
        throw new AgentControlError(409, '注册配置已变化，请重新检查后确认。');
      if (!preview.canRemove)
        throw new AgentControlError(
          409,
          '只能移除已停用、没有项目或历史引用、且没有正在检查连接或认证的 Agent。',
        );
      this.storage.repositories.agentDefinitions.delete(preview.agentId);
      this.configurationGenerations.set(id, (this.configurationGenerations.get(id) ?? 0) + 1);
      this.runtimeStates.delete(preview.agentId);
      return { agentId: preview.agentId, removed: true };
    });
  }

  constructor(
    private readonly storage: SqliteStorage,
    private readonly runtime: AgentRuntimeControl,
    options: AgentControlServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.catalogSources =
      options.catalogSources ?? new SqliteAgentCatalogSourcesRepository(storage.sqlite);
  }

  private registrationSource(definition: AgentDefinition): AgentCatalogSourceView | undefined {
    try {
      const record = this.catalogSources.get(definition.id);
      if (!record) return undefined;
      const runtimeFingerprint = createHash('sha256')
        .update(JSON.stringify(definition.runtime))
        .digest('hex');
      return AgentCatalogSourceViewSchema.parse({
        status: record.runtimeFingerprint === runtimeFingerprint ? 'linked' : 'entry-changed',
        record,
      });
    } catch {
      // Optional provenance failures must not erase connection or login evidence.
      return { status: 'unavailable', record: null };
    }
  }

  associateCatalogSource(id: string, input: unknown, rawSource: AgentCatalogSourceInput) {
    const request = z
      .object({
        expectedDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(input);
    const source = AgentCatalogSourceInputSchema.parse(rawSource);
    return this.storage.repositories.transaction(() => {
      const definition = this.requireAgent(id);
      if (definitionHash(definition) !== request.expectedDefinitionHash)
        throw new AgentControlError(
          409,
          '启动配置已变化，请重新核对后关联目录来源。',
          'AGENT_CONFIGURATION_CHANGED',
        );
      const runtimeFingerprint = createHash('sha256')
        .update(JSON.stringify(definition.runtime))
        .digest('hex');
      const previous = this.catalogSources.get(id);
      const unchanged =
        previous &&
        previous.runtimeFingerprint === runtimeFingerprint &&
        Object.entries(source).every(
          ([key, value]) => previous[key as keyof typeof previous] === value,
        );
      if (!unchanged) {
        try {
          this.catalogSources.save(
            id,
            request.expectedRevision,
            source,
            runtimeFingerprint,
            this.now(),
          );
        } catch (error) {
          if (error instanceof AgentCatalogSourceConflictError)
            throw new AgentControlError(
              409,
              '目录关联已在其他位置更新，请重新读取后再确认。',
              error.code,
            );
          throw error;
        }
      }
      return this.currentView(id);
    });
  }

  list(): RegisteredAgentView[] {
    return this.storage.repositories.agentDefinitions.list().map((definition) => ({
      definition,
      ...this.state(definition.id),
    }));
  }

  state(id: AgentId): AgentRuntimeState {
    const definition = this.storage.repositories.agentDefinitions.get(id);
    const inspected = definition
      ? inspectAgentConfiguration(definition, { localOnly: true })
      : undefined;
    const localEntry = inspected
      ? { offlineChecksPassed: inspected.offlineChecksPassed, issues: inspected.issues }
      : undefined;
    const current = this.runtimeStates.get(id);
    const revision = definition ? { definitionHash: definitionHash(definition) } : {};
    const source = definition ? this.registrationSource(definition) : undefined;
    const sourceMetadata = source ? { registrationSource: source } : {};
    const connectionOperation = this.authenticationsInFlight.has(id)
      ? ('auth' as const)
      : this.observationsInFlight.has(id)
        ? ('probe' as const)
        : undefined;
    if (current) {
      return {
        ...structuredClone(current),
        connectionOperation,
        ...revision,
        ...(localEntry ? { localEntry } : {}),
        ...sourceMetadata,
      };
    }
    return {
      connectionOperation,
      ...revision,
      readiness: {
        runtime: 'unknown',
        auth: 'unknown',
        observedAt: this.now(),
        authMethodIds: [],
      },
      authMethods: [],
      ...(localEntry ? { localEntry } : {}),
      ...sourceMetadata,
    };
  }

  create(input: unknown, rawSource?: AgentCatalogSourceInput): RegisteredAgentView {
    const definition = AgentDefinitionSchema.parse(input);
    const source =
      rawSource === undefined ? undefined : AgentCatalogSourceInputSchema.parse(rawSource);
    if (this.storage.repositories.agentDefinitions.get(definition.id)) {
      throw new AgentControlError(409, `Agent already exists: ${definition.id}`);
    }
    this.storage.repositories.transaction(() => {
      this.storage.repositories.agentDefinitions.upsert(definition);
      if (source)
        this.catalogSources.save(
          definition.id,
          0,
          source,
          createHash('sha256').update(JSON.stringify(definition.runtime)).digest('hex'),
          this.now(),
        );
    });
    this.configurationGenerations.set(
      definition.id,
      (this.configurationGenerations.get(definition.id) ?? 0) + 1,
    );
    this.runtimeStates.delete(definition.id);
    return { definition, ...this.state(definition.id) };
  }

  update(id: string, input: unknown): RegisteredAgentView {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AgentControlError(400, 'Agent patch must be an object.');
    }

    const patch = structuredClone(input as Record<string, unknown>);
    if (patch.id !== undefined && patch.id !== id) {
      throw new AgentControlError(400, 'Agent id cannot be changed.');
    }
    delete patch.id;
    const expectedHash = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .parse(patch.expectedDefinitionHash);
    delete patch.expectedDefinitionHash;
    return this.storage.repositories.transaction(() => {
      const current = this.requireAgent(id);
      if (expectedHash !== undefined && expectedHash !== definitionHash(current))
        throw new AgentControlError(
          409,
          '此成员配置已在其他位置更新。你的草稿仍保留，请读取最新配置并核对后再保存。',
          'AGENT_CONFIGURATION_CHANGED',
        );
      const definition = AgentDefinitionSchema.parse({ ...current, ...patch, id });
      // Running attempts retain their launch configuration. Reductions remain
      // immediate because every mediated operation rechecks current authority.
      const changesExecution =
        JSON.stringify(current.runtime) !== JSON.stringify(definition.runtime) ||
        JSON.stringify(current.auth) !== JSON.stringify(definition.auth) ||
        JSON.stringify(current.runnerSelector) !== JSON.stringify(definition.runnerSelector) ||
        current.permissions !== definition.permissions ||
        (!current.enabled && definition.enabled) ||
        (!current.orchestration.canBeBoss && definition.orchestration.canBeBoss) ||
        (definition.controlBridge.transport !== 'none' &&
          current.controlBridge.transport !== definition.controlBridge.transport) ||
        definition.controlBridge.scopes.some(
          (scope) => !current.controlBridge.scopes.includes(scope),
        );
      if (changesExecution) {
        const assignments = new Set(
          this.storage.repositories.assignments
            .list()
            .filter((assignment) => assignment.agentId === id)
            .map((assignment) => assignment.id),
        );
        const active = this.storage.repositories.executionAttempts
          .list()
          .some(
            (attempt) =>
              assignments.has(attempt.assignmentId) &&
              ['queued', 'running', 'waiting'].includes(attempt.state),
          );
        if (active)
          throw new AgentControlError(
            409,
            '此协作者仍有排队、执行或等待中的任务。请先停止任务或等待完成，再修改启动配置或扩大权限；停用和收回权限仍可立即操作。',
          );
      }
      this.storage.repositories.agentDefinitions.upsert(definition);
      if (connectionFingerprint(current) !== connectionFingerprint(definition)) {
        this.configurationGenerations.set(
          definition.id,
          (this.configurationGenerations.get(definition.id) ?? 0) + 1,
        );
        this.runtimeStates.delete(definition.id);
      }
      return { definition, ...this.state(definition.id) };
    });
  }

  async probe(id: string): Promise<RegisteredAgentView> {
    const definition = this.requireAgent(id);
    if (this.authenticationsInFlight.has(id))
      throw new AgentControlError(409, '此成员正在登录，请等待登录结果；其他成员仍可操作。');
    const isCurrent = this.beginObservation(definition);
    try {
      const observed = await this.runtime.probe(definition);
      if (!isCurrent()) return this.currentView(id);
      const next = structuredClone(observed);
      const previous = this.runtimeStates.get(definition.id)?.readiness.auth;
      // A fresh ACP initialize reports supported login methods, not whether the
      // agent-managed account is signed out. Keep the last confirmed auth state
      // for this unchanged registration; explicit login requirements still win.
      // Connection/authority updates clear runtimeStates and obsolete requests.
      if (
        next.readiness.runtime === 'ready' &&
        next.readiness.auth === 'unknown' &&
        (previous === 'ready' || previous === 'needs_login')
      ) {
        next.readiness.auth = previous;
      }
      this.runtimeStates.set(definition.id, next);
    } catch (error) {
      if (!isCurrent()) return this.currentView(id);
      this.runtimeStates.set(definition.id, {
        readiness: {
          runtime: 'error',
          auth: 'unknown',
          observedAt: this.now(),
          authMethodIds: [],
        },
        authMethods: [],
        error: error instanceof AgentConnectionFailure ? error.message : 'Agent probe failed.',
      });
    } finally {
      this.endObservation(id);
    }
    return this.currentView(id);
  }

  async authenticate(id: string, methodId: string): Promise<RegisteredAgentView> {
    const definition = this.requireAgent(id);
    const executing = this.storage.repositories.executionAttempts
      .list()
      .some(
        (attempt) =>
          ['queued', 'running', 'waiting'].includes(attempt.state) &&
          this.storage.repositories.assignments.get(attempt.assignmentId)?.agentId === id,
      );
    if (executing || this.observationsInFlight.has(id))
      throw new AgentControlError(409, '此成员正在执行任务或处理登录检查，请等待当前操作结束。');
    const method = this.state(definition.id).authMethods.find(
      (candidate) => candidate.id === methodId,
    );
    if (!method) {
      throw new AgentControlError(
        400,
        'Probe the agent first and choose an advertised authentication method.',
      );
    }
    await this.confirmAuthentication(definition, methodId);
    return this.currentView(id);
  }

  /** Release configuration selects the method; the runtime verifies it on the same connection. */
  async warmAuthentication(id: string, methodId: string): Promise<RegisteredAgentView> {
    await this.confirmAuthentication(this.requireAgent(id), methodId, false);
    return this.currentView(id);
  }

  close(): void {
    this.runtime.close?.();
  }

  private async confirmAuthentication(
    definition: AgentDefinition,
    methodId: string,
    interactive = true,
  ): Promise<RegisteredAgentView> {
    const id = definition.id;
    const previous = this.state(id);
    if (this.authenticationsInFlight.has(id))
      throw new AgentControlError(409, '此成员正在登录，请等待当前操作结束。');
    this.authenticationsInFlight.add(id);
    const isCurrent = this.beginObservation(definition);
    try {
      const observed = await this.runtime.authenticate(definition, methodId, { interactive });
      if (!isCurrent()) return this.currentView(id);
      this.runtimeStates.set(definition.id, structuredClone(observed));
      return this.currentView(id);
    } catch (error) {
      if (!isCurrent()) return this.currentView(id);
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new AgentControlError(400, error.message);
      }
      const connected =
        error instanceof AgentConnectionFailure && error.observation ? error.observation : previous;
      const connectionFailed =
        error instanceof AgentConnectionFailure &&
        !['authentication_failed', 'authentication_unavailable'].includes(error.reason);
      this.runtimeStates.set(definition.id, {
        ...connected,
        readiness: {
          runtime: connectionFailed ? 'error' : connected.readiness.runtime,
          auth: 'unknown',
          observedAt: this.now(),
          authMethodIds: connected.readiness.authMethodIds,
        },
        authMethods: connected.authMethods,
        error:
          error instanceof AgentConnectionFailure ? error.message : 'Agent authentication failed.',
      });
      throw new AgentControlError(
        502,
        error instanceof AgentConnectionFailure ? error.message : 'Agent authentication failed.',
        error instanceof AgentConnectionFailure ? error.reason : undefined,
      );
    } finally {
      this.authenticationsInFlight.delete(id);
      this.endObservation(id);
    }
  }

  selectBoss(projectId: string, agentId: string | null): Project {
    const project = this.storage.repositories.projects.get(projectId);
    if (!project) {
      throw new AgentControlError(404, `Project not found: ${projectId}`);
    }
    const agent = agentId === null ? undefined : this.requireAgent(agentId);
    if (
      agent &&
      (!agent.enabled ||
        !agent.orchestration.canBeBoss ||
        agent.controlBridge.transport !== 'mcp' ||
        !agent.controlBridge.scopes.includes('boss.orchestration'))
    ) {
      throw new AgentControlError(
        400,
        'Selected agent is not eligible for the V0 Boss MCP bridge.',
      );
    }

    const updated = ProjectSchema.parse({
      ...project,
      defaultBossAgentId: agent?.id,
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
    return reply
      .code(error.statusCode)
      .send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
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

  app.get('/api/system/agents/auto-discovery', async () => {
    const agents = service.list();
    const registeredCommands = agents.map((a) => a.definition.runtime.command);
    return {
      agents: detectInstalledAgentCLIs(registeredCommands),
    };
  });

  app.post('/api/agents/check-local', async (request, reply) => {
    try {
      const definition = AgentDefinitionSchema.parse(request.body);
      return inspectAgentConfiguration(definition, { localOnly: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

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

  app.get('/api/agents/:id/removal', async (request, reply) => {
    try {
      return service.removalPreview((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.delete('/api/agents/:id', async (request, reply) => {
    try {
      return service.remove((request.params as { id: string }).id, request.body);
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
      const body = SelectProjectBossInputSchema.parse(request.body);
      return service.selectBoss(id, body.agentId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
