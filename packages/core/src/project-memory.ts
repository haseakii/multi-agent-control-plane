import { z } from 'zod';
import {
  AuditActorSchema,
  ArtifactIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TimestampSchema,
} from './domain.js';

export const MemoryKindSchema = z.enum(['fact', 'constraint', 'decision', 'issue']);
export const MemoryStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'archived']);
export const ProposeMemorySchema = z
  .object({
    kind: MemoryKindSchema,
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(4000),
    sourceTaskId: TaskIdSchema.optional(),
    sourceArtifactIds: z.array(ArtifactIdSchema).max(16).default([]),
    supersedesId: z.string().min(1).max(128).optional(),
  })
  .strict();
export const ProjectMemorySchema = ProposeMemorySchema.extend({
  id: z.string().min(1).max(128),
  projectId: ProjectIdSchema,
  status: MemoryStatusSchema,
  proposedBy: AuditActorSchema,
  reviewedBy: AuditActorSchema.optional(),
  reviewedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
// The execution supplies sourceTaskId and proposer; an Agent cannot forge either.
export const AgentMemoryProposalSchema = ProposeMemorySchema.omit({ sourceTaskId: true });
export type AgentMemoryProposal = z.infer<typeof AgentMemoryProposalSchema>;
export const ReviewMemorySchema = z
  .object({ action: z.enum(['accept', 'reject', 'archive']) })
  .strict();

export const ContextSearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(256),
    source: z.enum(['memory', 'artifact']).optional(),
    kind: z.string().min(1).max(64).optional(),
    taskId: TaskIdSchema.optional(),
    since: TimestampSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ContextSearchQuery = z.infer<typeof ContextSearchQuerySchema>;
export const ContextSearchHitSchema = z
  .object({
    id: z.string(),
    source: z.enum(['memory', 'artifact']),
    title: z.string(),
    kind: z.string(),
    taskId: z.string().nullable(),
    createdAt: TimestampSchema,
    excerpt: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type ContextSearchHit = z.infer<typeof ContextSearchHitSchema>;
export interface ContextSearchIndex {
  search(projectId: string, query: ContextSearchQuery): ContextSearchHit[];
  hasArtifact(id: string): boolean;
}
