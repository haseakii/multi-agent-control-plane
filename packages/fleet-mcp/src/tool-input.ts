import { z } from 'zod';
import { AgentMemoryProposalSchema, ContextSearchQuerySchema } from '@control-plane/core';
import { FleetSendMessageSchema } from './message-input.js';

export const fleetToolInputSchemas = {
  control_search_knowledge: ContextSearchQuerySchema,
  control_propose_memory: AgentMemoryProposalSchema,
  control_discover_agents: z
    .object({
      exact: z.array(z.string().min(1).max(128)).optional(),
      prefixes: z.array(z.string().min(1).max(128)).optional(),
      custom: z.string().min(1).max(256).optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  control_get_agent: z.object({ agentId: z.string().min(1).max(128) }).strict(),
  control_create_task: z
    .object({
      title: z.string().min(1),
      objective: z.string().min(1),
      parentTaskId: z.string().min(1).optional(),
      dependencyIds: z.array(z.string().min(1)).optional(),
      contextRefs: z.array(z.string().min(1)).max(32).optional(),
    })
    .strict(),
  control_delegate_task: z
    .object({
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      objective: z.string().min(1).optional(),
      role: z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  control_get_task: z.object({ taskId: z.string().min(1) }).strict(),
  control_wait_task: z
    .object({
      taskId: z.string().min(1),
      timeoutMs: z.number().int().positive().max(300_000).optional(),
    })
    .strict(),
  control_send_message: FleetSendMessageSchema,
  control_publish_artifact: z
    .object({
      taskId: z.string().min(1).optional(),
      kind: z.enum([
        'plan',
        'report',
        'patch',
        'diff',
        'log',
        'image',
        'test-report',
        'file',
        'directory-manifest',
        'json',
        'text',
      ]),
      mimeType: z.string().min(1),
      content: z.string().max(1_000_000),
    })
    .strict(),
  control_get_artifact: z.object({ artifactId: z.string().min(1) }).strict(),
  control_request_approval: z
    .object({
      taskId: z.string().min(1).optional(),
      action: z.string().min(1),
      resource: z.record(z.string(), z.unknown()),
    })
    .strict(),
  control_cancel_task: z.object({ taskId: z.string().min(1) }).strict(),
} as const;

export type FleetToolName = keyof typeof fleetToolInputSchemas;

export function isFleetToolName(name: string): name is FleetToolName {
  return Object.prototype.hasOwnProperty.call(fleetToolInputSchemas, name);
}
