import { z } from 'zod';
import { ProjectIdSchema, TaskIdSchema, WorkspaceIdSchema, TimestampSchema } from './domain.js';
import { GitObjectIdSchema } from './workspace-review.js';

export const WorkspaceCleanupPlanSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    rootPath: z.string().min(1),
    directoryIdentity: z.string().min(1),
    mode: z.enum(['task-local', 'git-worktree']),
    head: GitObjectIdSchema.optional(),
    tree: GitObjectIdSchema.optional(),
    branch: z.string().min(1).optional(),
    removeBranch: z.boolean(),
    refs: z.array(z.object({ name: z.string().min(1), commit: GitObjectIdSchema }).strict()),
    notes: z.array(z.string()),
  })
  .strict();
export type WorkspaceCleanupPlan = z.infer<typeof WorkspaceCleanupPlanSchema>;
export const WorkspaceCleanupSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema,
    plan: WorkspaceCleanupPlanSchema,
    confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['removing', 'completed', 'failed']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    failure: z.string().optional(),
  })
  .strict();
export type WorkspaceCleanup = z.infer<typeof WorkspaceCleanupSchema>;
export const ConfirmWorkspaceCleanupSchema = z
  .object({
    confirmedWorkspaceId: WorkspaceIdSchema,
    confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const WorkspaceCleanupPreviewSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    rootPath: z.string(),
    eligible: z.boolean(),
    blockers: z.array(z.string()),
    plan: WorkspaceCleanupPlanSchema.optional(),
    confirmationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    record: WorkspaceCleanupSchema.optional(),
  })
  .strict();
export type WorkspaceCleanupPreview = z.infer<typeof WorkspaceCleanupPreviewSchema>;
