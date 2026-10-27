import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';

export const bridgeScopes = [
  ['boss.orchestration', '编排任务', '创建与委派任务，适用于负责人'],
  ['agent.messaging', '协作消息', '通过控制平面与其他协作者通信'],
  ['artifact.read', '读取产物', '读取当前任务范围内允许访问的产物'],
  ['artifact.publish', '提交产物', '将执行结果保存为产物'],
  ['task.status', '报告进展', '查询或更新允许范围内的任务状态'],
  ['knowledge.read', '读取知识', '读取项目提供的知识'],
  ['memory.propose', '提议记忆', '提交项目记忆建议'],
] as const;
const Scope = z.enum([
  'boss.orchestration',
  'agent.messaging',
  'artifact.read',
  'artifact.publish',
  'task.status',
  'knowledge.read',
  'memory.propose',
]);
export const AgentRuntime = z
  .object({
    type: z.literal('acp-stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    environmentAllowlist: z.array(z.string().min(1)).optional(),
  })
  .strict();
export const AgentDefinition = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean(),
    runtime: AgentRuntime,
    capabilities: z.array(
      z
        .object({
          name: z.string().min(1).max(128),
          source: z.enum(['configured', 'advertised', 'verified']),
        })
        .strict(),
    ),
    auth: z.union([
      z.object({ mode: z.literal('agent-managed') }).strict(),
      z.object({ mode: z.literal('secret-ref'), secretRef: z.string().min(1) }).strict(),
    ]),
    permissions: z.string().min(1).optional(),
    runnerSelector: z
      .object({ os: z.string().min(1).optional(), labels: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    orchestration: z.object({ canBeBoss: z.boolean() }).strict(),
    controlBridge: z
      .object({ transport: z.enum(['mcp', 'cli', 'structured', 'none']), scopes: z.array(Scope) })
      .strict(),
  })
  .strict()
  .refine(
    (value) => value.controlBridge.transport !== 'none' || value.controlBridge.scopes.length === 0,
    { message: '关闭协作接口时不能保留协作权限。', path: ['controlBridge'] },
  );
export type AgentDefinitionData = z.infer<typeof AgentDefinition>;
export const AgentRegistrationSource = z
  .object({
    status: z.enum(['linked', 'entry-changed', 'unavailable']),
    record: z
      .object({
        agentId: z.string(),
        entryId: z.string(),
        entryName: z.string(),
        catalogVersion: z.string(),
        catalogUrl: z.string().url(),
        revision: z.number().int().positive(),
        runtimeFingerprint: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .nullable(),
  })
  .refine((value) =>
    value.status === 'unavailable' ? value.record === null : value.record !== null,
  );
export const AgentConnection = z.object({
  connectionOperation: z.enum(['probe', 'auth']).optional(),
  definitionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  definition: AgentDefinition,
  readiness: z.object({
    runtime: z.enum(['unknown', 'ready', 'error']),
    auth: z.enum(['unknown', 'needs_login', 'ready', 'not_reported']),
    observedAt: z.string(),
  }),
  authMethods: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() })),
  error: z.string().optional(),
  negotiation: z.object({ agentInfo: z.unknown().optional() }).optional(),
  registrationSource: AgentRegistrationSource.optional(),
  localEntry: z
    .object({
      offlineChecksPassed: z.boolean(),
      issues: z.array(z.object({ code: z.string(), message: z.string() })),
    })
    .optional(),
});
export type AgentConnectionData = z.infer<typeof AgentConnection>;
export const Activity = z.object({
  assignments: z.array(z.object({ id: z.string(), agentId: z.string() })),
  executionAttempts: z.array(z.object({ assignmentId: z.string(), state: z.string() })),
});
export function activeAgents(activity: z.infer<typeof Activity>) {
  const activeAssignments = new Set(
    activity.executionAttempts
      .filter((attempt) => ['queued', 'running', 'waiting'].includes(attempt.state))
      .map((attempt) => attempt.assignmentId),
  );
  return activity.assignments
    .filter((assignment) => activeAssignments.has(assignment.id))
    .map((assignment) => assignment.agentId);
}
export async function ensureAgentIdle(agentId: string, signal?: AbortSignal) {
  const current = await fetchJSON('/api/control-center?view=conversation', { signal }, Activity);
  if (activeAgents(current).includes(agentId))
    throw new Error('此协作者正在处理任务，请在任务结束后修改配置。');
}
export function configurationError(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；');
  const message = error instanceof Error ? error.message : String(error);
  const http = message.match(/^HTTP (\d+): ([\s\S]*)$/);
  if (http) {
    try {
      const body = JSON.parse(http[2]);
      if (typeof body.error === 'string') return body.error;
    } catch {
      /* Preserve the transport error when the server returned no JSON. */
    }
  }
  return message;
}

export function configurationConflict(error: unknown) {
  const match = (error instanceof Error ? error.message : String(error)).match(
    /^HTTP 409: ([\s\S]*)$/,
  );
  if (!match) return false;
  try {
    return JSON.parse(match[1]).code === 'AGENT_CONFIGURATION_CHANGED';
  } catch {
    return false;
  }
}
