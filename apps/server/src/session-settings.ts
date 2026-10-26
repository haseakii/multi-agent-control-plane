import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AgentIdSchema,
  AgentSessionDefaultsSchema,
  AgentSessionPresetSchema,
  AgentSessionPresetIdSchema,
  AgentSessionPresetRevisionSchema,
  CreateAgentSessionPresetSchema,
  SessionSettingsSnapshotSchema,
  SessionSettingValuesSchema,
  UpdateAgentSessionPresetSchema,
  type AgentDefinition,
} from '@control-plane/core';
import {
  SessionPresetsError,
  type SessionPresetsRepository,
  type SessionSettingsRepository,
} from '@control-plane/storage';
import {
  AcpSessionSettingsError,
  SessionSettingsInspectionSchema,
  type AgentReadiness,
  type SessionSettingsInspection,
} from '@control-plane/acp-runtime';

export class SessionSettingsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = (agent: AgentDefinition) => hash(agent);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const staleReasonSchema = z.enum([
  'expired',
  'definition-changed',
  'readiness-changed',
  'inspection-failed',
  'network-changed',
]);
const readinessEvidenceSchema = z
  .object({
    runtime: z.enum(['unknown', 'ready', 'error']),
    auth: z.enum(['unknown', 'needs_login', 'ready', 'not_reported']),
    observedAt: z.string().datetime().nullable(),
    authMethodIds: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict();
export const SessionSettingsCacheObservationSchema = z
  .object({
    source: z.literal('acp-session-new'),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    sessionIdHash: digest,
    definitionFingerprint: digest,
    readinessFingerprint: digest,
    networkFingerprint: digest.optional(),
    accountIdentity: z.literal('not-exposed'),
    accountIdentityNote: z.literal('账号身份未由 ACP 暴露；仅绑定当前可观察的登录与连接就绪证据。'),
  })
  .strict();
export const AgentSessionSettingsViewSchema = z
  .object({
    agentId: AgentIdSchema,
    projectId: z.string().min(1).max(128).optional(),
    settings: SessionSettingsSnapshotSchema.nullable(),
    defaults: AgentSessionDefaultsSchema,
    freshness: z.enum(['fresh', 'stale', 'unavailable']),
    staleReason: staleReasonSchema.nullable(),
    observation: SessionSettingsCacheObservationSchema.nullable(),
  })
  .strict();
const presetListSchema = z
  .object({ agentId: AgentIdSchema, presets: z.array(AgentSessionPresetSchema).max(128) })
  .strict();
export const CreateSessionPresetInputSchema = CreateAgentSessionPresetSchema.omit({
  agentId: true,
});
export const UpdateSessionPresetInputSchema = z
  .object({
    expectedRevision: AgentSessionPresetRevisionSchema,
    ...UpdateAgentSessionPresetSchema.shape,
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.values !== undefined,
    'No preset changes supplied.',
  );
export const SessionPresetRevisionInputSchema = z
  .object({ expectedRevision: AgentSessionPresetRevisionSchema })
  .strict();

type CacheEntry = {
  settings: SessionSettingsInspection['settings'];
  observation: z.infer<typeof SessionSettingsCacheObservationSchema>;
  invalidated: boolean;
};
export type SessionSettingsServiceOptions = {
  presets?: SessionPresetsRepository;
  now?: () => number;
  ttlMs?: number;
};
export class SessionSettingsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(
    readonly repository: SessionSettingsRepository,
    private readonly host: {
      agent(id: string): AgentDefinition;
      readiness(id: string): AgentReadiness;
      networkFingerprint?(id: string): string;
      cwd(projectId?: string): string;
      inspect(
        agent: AgentDefinition,
        cwd: string,
        values: Record<string, string>,
      ): Promise<SessionSettingsInspection>;
    },
    private readonly options: SessionSettingsServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 5 * 60_000)
      throw new RangeError('Session setting cache lifetime must be at most five minutes.');
  }
  private key(agentId: string, projectId?: string) {
    return JSON.stringify([agentId, projectId ?? null]);
  }
  private readinessFingerprint(agentId: string) {
    const readiness = this.host.readiness(agentId);
    // AgentControl synthesizes now for an unobserved member on every read; that is not an auth observation.
    const unobserved = readiness.runtime === 'unknown' && readiness.auth === 'unknown';
    return hash(
      readinessEvidenceSchema.parse({
        runtime: readiness.runtime,
        auth: readiness.auth,
        observedAt: unobserved ? null : readiness.observedAt,
        authMethodIds: [...readiness.authMethodIds].sort(),
      }),
    );
  }
  private staleReason(agentId: string, cached: CacheEntry, definition: AgentDefinition) {
    if (cached.observation.definitionFingerprint !== fingerprint(definition))
      return 'definition-changed' as const;
    if (cached.observation.readinessFingerprint !== this.readinessFingerprint(agentId))
      return 'readiness-changed' as const;
    if (cached.observation.networkFingerprint !== this.host.networkFingerprint?.(agentId))
      return 'network-changed' as const;
    if (cached.invalidated) return 'inspection-failed' as const;
    if (this.now() >= Date.parse(cached.observation.expiresAt)) return 'expired' as const;
    return null;
  }
  read(agentId: string, projectId?: string) {
    const agent = this.host.agent(agentId);
    if (projectId) this.host.cwd(projectId);
    const cached = this.cache.get(this.key(agentId, projectId));
    const reason = cached ? this.staleReason(agentId, cached, agent) : null;
    return AgentSessionSettingsViewSchema.parse({
      agentId,
      ...(projectId ? { projectId } : {}),
      settings: cached?.settings ?? null,
      defaults: this.repository.getDefaults(agentId),
      freshness: cached ? (reason ? 'stale' : 'fresh') : 'unavailable',
      staleReason: reason,
      observation: cached?.observation ?? null,
    });
  }
  async inspect(agentId: string, projectId?: string, rawValues?: unknown) {
    const agent = this.host.agent(agentId),
      version = fingerprint(agent),
      readiness = this.readinessFingerprint(agentId),
      networkFingerprint = this.host.networkFingerprint?.(agentId);
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
      const inspected = SessionSettingsInspectionSchema.parse(
        await this.host.inspect(agent, cwd, values),
      );
      if (
        fingerprint(this.host.agent(agentId)) !== version ||
        this.readinessFingerprint(agentId) !== readiness ||
        this.host.networkFingerprint?.(agentId) !== networkFingerprint
      )
        throw new SessionSettingsError(409, '成员配置或登录就绪证据已变化，请重新读取运行设置。');
      const observation = SessionSettingsCacheObservationSchema.parse({
        ...inspected.observation,
        expiresAt: new Date(
          Date.parse(inspected.observation.observedAt) + this.ttlMs,
        ).toISOString(),
        definitionFingerprint: version,
        readinessFingerprint: readiness,
        ...(networkFingerprint ? { networkFingerprint } : {}),
        accountIdentity: 'not-exposed',
        accountIdentityNote: '账号身份未由 ACP 暴露；仅绑定当前可观察的登录与连接就绪证据。',
      });
      this.cache.set(key, { settings: inspected.settings, observation, invalidated: false });
      return this.read(agentId, projectId);
    } catch (error) {
      const previous = this.cache.get(key);
      if (previous) previous.invalidated = true;
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
  private requireFreshValues(agentId: string, values: Record<string, string>) {
    const agent = this.host.agent(agentId);
    if (!agent.enabled)
      throw new SessionSettingsError(409, '此成员已停用，请先启用后核对运行设置。');
    const observed = [...this.cache.entries()].filter(
      ([key, cached]) =>
        JSON.parse(key)[0] === agentId && !this.staleReason(agentId, cached, agent),
    );
    if (
      !observed.some(([, cached]) =>
        Object.entries(values).every(([id, value]) =>
          cached.settings.options.some(
            (option) => option.id === id && option.currentValue === value,
          ),
        ),
      )
    )
      throw new SessionSettingsError(
        409,
        '请先重新读取并核对这组真实可用选项，再保存；旧缓存和其他登录就绪证据不能用于确认。',
        'SESSION_SETTINGS_REVALIDATION_REQUIRED',
      );
  }
  saveDefaults(agentId: string, raw: unknown) {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        values: SessionSettingValuesSchema,
      })
      .strict()
      .parse(raw);
    this.requireFreshValues(agentId, input.values);
    try {
      return this.repository.saveDefaults(agentId, input.expectedRevision, input.values);
    } catch {
      throw new SessionSettingsError(409, '默认设置已变化，请重新读取后再保存。');
    }
  }
  private presets() {
    if (!this.options.presets) throw new SessionSettingsError(503, '此服务尚未启用常用方案存储。');
    return this.options.presets;
  }
  private presetOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof SessionPresetsError)) throw error;
      const messages = {
        PRESET_NOT_FOUND: '找不到此常用方案，请重新读取列表。',
        PRESET_REVISION_CONFLICT: '此常用方案已在其他位置更新，请重新读取后再保存。',
        PRESET_NAME_CONFLICT: '此成员已有同名常用方案，请换一个名称。',
        PRESET_LIMIT_EXCEEDED: '常用方案已达上限（32 个启用、128 个含归档），请整理已有方案。',
      };
      throw new SessionSettingsError(
        error.code === 'PRESET_NOT_FOUND' ? 404 : 409,
        messages[error.code],
        error.code,
      );
    }
  }
  listPresets(agentId: string, includeArchived = false) {
    this.host.agent(agentId);
    return presetListSchema.parse({
      agentId,
      presets: this.presets().list(agentId, {
        includeArchived: z.boolean().parse(includeArchived),
      }),
    });
  }
  getPreset(agentId: string, presetId: string) {
    this.host.agent(agentId);
    const id = AgentSessionPresetIdSchema.parse(presetId);
    const preset = this.presets().get(agentId, id);
    if (!preset)
      throw new SessionSettingsError(404, '找不到此常用方案，请重新读取列表。', 'PRESET_NOT_FOUND');
    return AgentSessionPresetSchema.parse(preset);
  }
  createPreset(agentId: string, raw: unknown) {
    const input = CreateSessionPresetInputSchema.parse(raw);
    this.host.agent(agentId);
    const existing = this.presets().get(agentId, input.id);
    if (existing) {
      const keys = Object.keys(input.values);
      if (
        !existing.archived &&
        existing.revision === 1 &&
        existing.name === input.name &&
        keys.length === Object.keys(existing.values).length &&
        keys.every((key) => existing.values[key] === input.values[key])
      )
        return AgentSessionPresetSchema.parse(existing);
      throw new SessionSettingsError(
        409,
        '此保存标识已有其他结果，请重新读取常用方案后核对。',
        'PRESET_REVISION_CONFLICT',
      );
    }
    this.requireFreshValues(agentId, input.values);
    return this.presetOperation(() => this.presets().create({ ...input, agentId }));
  }
  updatePreset(agentId: string, presetId: string, raw: unknown) {
    this.host.agent(agentId);
    const id = AgentSessionPresetIdSchema.parse(presetId);
    const { expectedRevision, ...patch } = UpdateSessionPresetInputSchema.parse(raw);
    if (patch.values !== undefined) this.requireFreshValues(agentId, patch.values);
    return this.presetOperation(() => this.presets().update(agentId, id, expectedRevision, patch));
  }
  archivePreset(agentId: string, presetId: string, raw: unknown, restore = false) {
    this.host.agent(agentId);
    const id = AgentSessionPresetIdSchema.parse(presetId);
    const { expectedRevision } = SessionPresetRevisionInputSchema.parse(raw);
    return this.presetOperation(() =>
      restore
        ? this.presets().restore(agentId, id, expectedRevision)
        : this.presets().archive(agentId, id, expectedRevision),
    );
  }
  prepare(
    taskId: string,
    agentId: string,
    explicit?: Record<string, string>,
    previousTaskId?: string,
    presetId?: string,
  ) {
    if (explicit !== undefined && presetId !== undefined)
      throw new SessionSettingsError(400, '运行设置与常用方案不能同时指定。');
    const existing = this.repository.getTask(taskId);
    if (existing) {
      if (existing.agentId !== agentId)
        throw new SessionSettingsError(409, '已冻结的运行设置属于另一位成员，请创建新任务。');
      return;
    }
    const preset = presetId === undefined ? undefined : this.getPreset(agentId, presetId);
    if (preset?.archived)
      throw new SessionSettingsError(
        409,
        '此常用方案已归档，请选择启用的方案。',
        'PRESET_ARCHIVED',
      );
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
        preset?.values ?? explicit ?? inherited ?? this.repository.getDefaults(agentId).values,
      ),
      ...(preset
        ? { selectedPreset: { id: preset.id, revision: preset.revision, name: preset.name } }
        : {}),
      state: 'requested',
    });
  }
}
