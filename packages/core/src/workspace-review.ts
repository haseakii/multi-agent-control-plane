import { z } from 'zod';
import {
  ProjectIdSchema,
  TaskIdSchema,
  AssignmentIdSchema,
  WorkspaceIdSchema,
  ArtifactIdSchema,
  ApprovalIdSchema,
  TimestampSchema,
} from './domain.js';
export const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const WorkspaceChangeFileSchema = z
  .object({
    path: z.string().min(1),
    status: z.enum(['A', 'M', 'D', 'T']),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type WorkspaceChangeFile = z.infer<typeof WorkspaceChangeFileSchema>;
export const WorkspaceReviewSchema = z
  .object({
    id: z.string().uuid(),
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema,
    assignmentId: AssignmentIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    baseRevision: GitObjectIdSchema,
    workspaceHead: GitObjectIdSchema,
    snapshotCommit: GitObjectIdSchema,
    mergeCommit: GitObjectIdSchema,
    targetHead: GitObjectIdSchema,
    targetBranch: z.string().min(1),
    files: z.array(WorkspaceChangeFileSchema),
    patchArtifactId: ArtifactIdSchema,
    manifestArtifactId: ArtifactIdSchema,
    approvalId: ApprovalIdSchema,
    state: z.enum(['ready', 'applying', 'merged', 'failed']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    mergedAt: TimestampSchema.optional(),
    failure: z.string().optional(),
  })
  .strict();
export type WorkspaceReview = z.infer<typeof WorkspaceReviewSchema>;
export const MergeWorkspaceReviewSchema = z
  .object({
    confirmedTargetBranch: z.string().min(1),
    confirmedMergeCommit: GitObjectIdSchema,
  })
  .strict();
