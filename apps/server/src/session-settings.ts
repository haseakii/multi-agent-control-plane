import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  SessionSettingValuesSchema,
  type AgentDefinition,
  type SessionSettingsSnapshot,
} from '@control-plane/core';
import type { SessionSettingsRepository } from '@control-plane/storage';
import { AcpSessionSettingsError } from '@control-plane/acp-runtime';

export class SessionSettingsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const fingerprint = (agent: AgentDefinition) =>
  createHash('sha256').update(JSON.stringify(agent)).digest('hex');
export class SessionSettingsService {
  private readonly cache = new Map<
    string,
    { fingerprint: string; settings: SessionSettingsSnapshot }
  >();
  private readonly busy = new Set<string>();
  constructor(
    readonly repository: SessionSettingsRepository,
    private readonly host: {
      agent(id: string): AgentDefinition;
      cwd(projectId?: string): string;
      inspect(
        agent: AgentDefinition,
        cwd: string,
        values: Record<string, string>,
      ): Promise<SessionSettingsSnapshot>;
    },
  ) {}
  private key(agentId: string, projectId?: string) {
    return JSON.stringify([agentId, projectId ?? null]);
  }
  read(agentId: string, projectId?: string) {
    const agent = this.host.agent(agentId);
    if (projectId) this.host.cwd(projectId);
    const cached = this.cache.get(this.key(agentId, projectId));
    return {
      agentId,
      ...(projectId ? { projectId } : {}),
      settings: cached?.fingerprint === fingerprint(agent) ? cached.settings : null,
      defaults: this.repository.getDefaults(agentId),
    };
  }
  async inspect(agentId: string, projectId?: string, rawValues?: unknown) {
    const agent = this.host.agent(agentId),
      version = fingerprint(agent);
    if (!agent.enabled)
      throw new SessionSettingsError(409, '此成员已停用，请先启用后读取运行设置。');
    const key = this.key(agentId, projectId);
    if (this.busy.has(key))
      throw new SessionSettingsError(409, '正在读取此成员的设置，请等待当前请求完成。');
    const values = SessionSettingValuesSchema.parse(
      rawValues ?? this.repository.getDefaults(agentId).values,
    );
    const cwd = this.host.cwd(projectId);
    this.busy.add(key);
    try {
      const settings = await this.host.inspect(agent, cwd, values);
      if (fingerprint(this.host.agent(agentId)) !== version)
        throw new SessionSettingsError(409, '成员配置已变化，请重新读取运行设置。');
      this.cache.set(key, { fingerprint: version, settings });
      return this.read(agentId, projectId);
    } catch (error) {
      if (error instanceof SessionSettingsError) throw error;
      if (error instanceof AcpSessionSettingsError)
        throw new SessionSettingsError(409, error.message);
      throw new SessionSettingsError(
        409,
        '成员未能读取或确认这些运行设置。请重新读取可用选项；已知登录状态和默认设置没有改变。',
      );
    } finally {
      this.busy.delete(key);
    }
  }
  saveDefaults(agentId: string, raw: unknown) {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        values: SessionSettingValuesSchema,
      })
      .strict()
      .parse(raw);
    const agent = this.host.agent(agentId);
    const observed = [...this.cache.entries()]
      .filter(
        ([key, value]) =>
          JSON.parse(key)[0] === agentId && value.fingerprint === fingerprint(agent),
      )
      .map(([, value]) => value.settings);
    if (
      Object.keys(input.values).length &&
      !observed.some((settings) =>
        Object.entries(input.values).every(([id, value]) =>
          settings.options.some((option) => option.id === id && option.currentValue === value),
        ),
      )
    )
      throw new SessionSettingsError(409, '请先读取并核对这组真实可用选项，再保存默认设置。');
    try {
      return this.repository.saveDefaults(agentId, input.expectedRevision, input.values);
    } catch {
      throw new SessionSettingsError(409, '默认设置已变化，请重新读取后再保存。');
    }
  }
  prepare(
    taskId: string,
    agentId: string,
    explicit?: Record<string, string>,
    previousTaskId?: string,
  ) {
    const existing = this.repository.getTask(taskId);
    if (existing) {
      if (existing.agentId !== agentId)
        throw new SessionSettingsError(409, '已冻结的运行设置属于另一位成员，请创建新任务。');
      return;
    }
    const previous = previousTaskId ? this.repository.getTask(previousTaskId) : undefined;
    const inherited =
      previous?.agentId === agentId
        ? previous.confirmed
          ? Object.fromEntries(
              previous.confirmed.options.map((option) => [option.id, option.currentValue]),
            )
          : previous.requested
        : undefined;
    this.repository.putTask({
      taskId,
      agentId,
      requested: SessionSettingValuesSchema.parse(
        explicit ?? inherited ?? this.repository.getDefaults(agentId).values,
      ),
      state: 'requested',
    });
  }
}
