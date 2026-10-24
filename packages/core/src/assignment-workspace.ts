import { z } from 'zod';
import {
  AssignmentIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from './domain.js';

export const ExecutionWorkspaceModeSchema = z.enum([
  'task-local',
  'git-worktree',
  'shared-directory',
]);
export type ExecutionWorkspaceMode = z.infer<typeof ExecutionWorkspaceModeSchema>;

export const ProjectWorkspaceConfigSchema = z
  .object({
    id: ProjectIdSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    mode: z.enum(['unconfigured', 'task-local', 'git-worktree', 'shared-directory']),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ProjectWorkspaceConfig = z.infer<typeof ProjectWorkspaceConfigSchema>;

export const AssignmentWorkspaceSchema = z
  .object({
    id: AssignmentIdSchema,
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    mode: ExecutionWorkspaceModeSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type AssignmentWorkspace = z.infer<typeof AssignmentWorkspaceSchema>;
