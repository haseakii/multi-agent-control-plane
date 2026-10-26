import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AgentIdSchema,
  type AgentDefinition,
  type AgentCatalogSourceInput,
  type InstalledAgentPackage,
} from '@control-plane/core';
import { SqliteAgentCatalogSourcesRepository, type SqliteStorage } from '@control-plane/storage';
import { AgentControlError, type AgentControlService } from './agent-control.js';
import { inspectAgentConfiguration } from '@control-plane/runner';
import { TaskControlError } from './task-control.js';

export const CreateAgentMemberSchema = z
  .object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(128) })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Installed programs and member identities have separate lifecycles. No account files are copied. */
export class AgentMembersService {
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly agents: AgentControlService,
  ) {}
  get busy() {
    return this.active.size > 0;
  }
  async settle() {
    await Promise.allSettled(this.active.values());
  }
  fromAgent(sourceId: string, raw: unknown) {
    const input = CreateAgentMemberSchema.parse(raw);
    const origin = { sourceAgentId: AgentIdSchema.parse(sourceId) };
    const reuse = this.reuse(origin, input);
    if (reuse) return reuse;
    const definition = this.storage.repositories.agentDefinitions.get(sourceId);
    if (!definition) throw new TaskControlError(404, '源成员不存在，请刷新成员列表。');
    if (definition.auth.mode !== 'agent-managed')
      throw new TaskControlError(409, '此入口使用受控凭据引用。请选用成员自行登录的程序入口。');
    const association = new SqliteAgentCatalogSourcesRepository(this.storage.sqlite).get(sourceId);
    const source =
      association?.runtimeFingerprint === hash(definition.runtime)
        ? {
            entryId: association.entryId,
            entryName: association.entryName,
            catalogVersion: association.catalogVersion,
            catalogUrl: association.catalogUrl,
          }
        : undefined;
    return this.create(origin, input, definition.runtime, source);
  }
  fromPackage(installationId: string, pkg: InstalledAgentPackage, raw: unknown) {
    const input = CreateAgentMemberSchema.parse(raw),
      origin = { installationId: z.string().uuid().parse(installationId) };
    return this.reuse(origin, input) ?? this.create(origin, input, pkg.runtime, pkg.source);
  }
  private reuse(
    origin: { sourceAgentId?: string; installationId?: string },
    input: z.infer<typeof CreateAgentMemberSchema>,
  ) {
    const id = 'member-' + input.requestId,
      row = this.storage.repositories.agentMemberOrigins.get(id);
    if (!row) return undefined;
    if (row.requestHash !== hash({ ...origin, ...input }))
      throw new TaskControlError(409, '此创建请求已有其他内容，请重新确认成员名称。');
    if (!this.storage.repositories.agentDefinitions.get(id))
      throw new TaskControlError(409, '此请求创建的成员已移除。请重新创建一位成员。');
    return (this.active.get(id) ?? Promise.resolve()).then(() => this.receipt(id, true));
  }
  private create(
    origin: { sourceAgentId?: string; installationId?: string },
    input: z.infer<typeof CreateAgentMemberSchema>,
    runtime: AgentDefinition['runtime'],
    source?: AgentCatalogSourceInput,
  ) {
    const id = AgentIdSchema.parse('member-' + input.requestId);
    const definition = {
      id,
      name: input.name,
      enabled: true,
      runtime: structuredClone(runtime),
      capabilities: [],
      auth: { mode: 'agent-managed' as const },
      orchestration: { canBeBoss: false },
      controlBridge: {
        transport: 'mcp' as const,
        scopes: ['agent.messaging', 'artifact.read', 'artifact.publish', 'task.status'],
      },
    };
    if (!inspectAgentConfiguration(definition, { localOnly: true }).offlineChecksPassed)
      throw new TaskControlError(409, '现有程序入口不可用，请先修复程序路径，再创建成员。');
    this.storage.repositories.transaction(() => {
      this.agents.create(definition, source);
      this.storage.repositories.agentMemberOrigins.upsert({
        id,
        ...origin,
        requestId: input.requestId,
        requestHash: hash({ ...origin, ...input }),
        runtimeFingerprint: hash(runtime),
        createdAt: new Date().toISOString(),
      });
    });
    const check = this.agents.probe(id).finally(() => this.active.delete(id));
    this.active.set(id, check);
    return check.then(() => this.receipt(id, false));
  }
  private receipt(id: string, reused: boolean) {
    const member = this.agents.list().find((item) => item.definition.id === id)!;
    return {
      member,
      reused,
      ready: member.readiness.runtime === 'ready',
      message:
        member.readiness.runtime === 'ready'
          ? '成员已创建，程序已复用。请通过成员自己的入口确认登录，并分别设置模型与代理。'
          : '成员已创建，连接检查未完成。已有配置保留，可在成员卡查看原因并重试。',
    };
  }
}
export function registerAgentMemberRoutes(app: FastifyInstance, service: AgentMembersService) {
  app.post('/api/agents/:id/members', async (request, reply) => {
    try {
      return await service.fromAgent(
        z.object({ id: AgentIdSchema }).strict().parse(request.params).id,
        request.body,
      );
    } catch (error) {
      return reply
        .code(
          error instanceof TaskControlError || error instanceof AgentControlError
            ? error.statusCode
            : error instanceof z.ZodError
              ? 400
              : 409,
        )
        .send({
          error:
            error instanceof TaskControlError
              ? error.message
              : '成员创建尚未确认。请刷新列表或使用同一请求重试。',
        });
    }
  });
  app.addHook('preClose', async () => {
    await service.settle();
  });
}
