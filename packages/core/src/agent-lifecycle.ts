import { z } from 'zod';
import { AgentIdSchema, TimestampSchema } from './domain.js';

export const AgentReferenceKindSchema = z.enum([
  'project',
  'boss-assignment',
  'task',
  'assignment',
  'conversation',
  'message',
  'delivery',
  'artifact',
  'approval',
  'event',
  'memory',
]);
export const AgentReferenceCountSchema = z
  .object({
    kind: AgentReferenceKindSchema,
    count: z.number().int().positive(),
  })
  .strict();
export type AgentReferenceCount = z.infer<typeof AgentReferenceCountSchema>;
export const AgentRemovalPreviewSchema = z
  .object({
    agentId: AgentIdSchema,
    name: z.string(),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: TimestampSchema,
    canRemove: z.boolean(),
    blockers: z.array(z.enum(['enabled', 'referenced', 'observation-in-progress'])),
    references: z.array(AgentReferenceCountSchema),
  })
  .strict();
export type AgentRemovalPreview = z.infer<typeof AgentRemovalPreviewSchema>;
export const RemoveAgentInputSchema = z
  .object({
    confirmedAgentId: AgentIdSchema,
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const SelectProjectBossInputSchema = z
  .object({ agentId: AgentIdSchema.nullable() })
  .strict();
