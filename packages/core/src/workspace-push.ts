import { z } from 'zod';
import {
  ProjectIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
  ApprovalIdSchema,
  TimestampSchema,
} from './domain.js';
import { GitObjectIdSchema } from './workspace-review.js';
export const GitRemoteNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const WorkspacePushInputSchema = z.object({ remote: GitRemoteNameSchema }).strict();
export const WorkspacePushSchema = z
  .object({
    id: z.string().uuid(),
    reviewId: z.string().uuid(),
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    remote: GitRemoteNameSchema,
    destination: z.string().min(1),
    destinationHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetBranch: z.string().min(1),
    commit: GitObjectIdSchema,
    approvalId: ApprovalIdSchema,
    state: z.enum(['ready', 'pushing', 'pushed', 'failed']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    pushedAt: TimestampSchema.optional(),
    failure: z.string().optional(),
  })
  .strict();
export type WorkspacePush = z.infer<typeof WorkspacePushSchema>;
export const ConfirmWorkspacePushSchema = z
  .object({
    confirmedCommit: GitObjectIdSchema,
    confirmedDestinationHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
