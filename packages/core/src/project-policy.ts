import { z } from 'zod';
import { ProjectIdSchema, TimestampSchema } from './domain.js';
export const ProjectToolActionSchema = z.enum([
  'control_discover_agents',
  'control_get_agent',
  'control_create_task',
  'control_delegate_task',
  'control_get_task',
  'control_wait_task',
  'control_send_message',
  'control_publish_artifact',
  'control_get_artifact',
  'control_request_approval',
  'control_cancel_task',
  'control_search_knowledge',
  'control_propose_memory',
]);
export const AgentPermissionsSchema = z
  .object({
    workspaceFiles: z.enum(['ask', 'auto', 'deny']).default('ask'),
    commands: z.enum(['ask', 'deny']).default('ask'),
    outsideWorkspace: z.enum(['ask', 'deny']).default('ask'),
  })
  .strict();
export const ProjectPolicyInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    tools: z.partialRecord(ProjectToolActionSchema, z.enum(['allow', 'deny'])),
    gitMerge: z.enum(['ask', 'deny']),
    gitPush: z.enum(['ask', 'deny']).default('deny'),
    requireEnforcedExecution: z.boolean(),
    agentPermissions: AgentPermissionsSchema.default({
      workspaceFiles: 'ask',
      commands: 'ask',
      outsideWorkspace: 'ask',
    }),
  })
  .strict();
export const ProjectPolicySchema = ProjectPolicyInputSchema.omit({ expectedRevision: true })
  .extend({
    id: ProjectIdSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;
