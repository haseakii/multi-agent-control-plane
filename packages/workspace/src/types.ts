import {
  AgentIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  WorkspaceAccessSchema,
  WorkspaceIdSchema,
  GitObjectIdSchema,
} from '@control-plane/core';
import { z } from 'zod';

export const LocalDirectoryWorkspaceInputSchema = z
  .object({
    id: WorkspaceIdSchema.optional(),
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    requesterAgentId: AgentIdSchema.optional(),
    rootPath: z.string().min(1),
    access: WorkspaceAccessSchema,
    requiresEnforcedBoundary: z.boolean().default(false),
  })
  .strict();
export type LocalDirectoryWorkspaceInput = z.input<typeof LocalDirectoryWorkspaceInputSchema>;

export const GitWorktreeCreateInputSchema = z
  .object({
    id: WorkspaceIdSchema.optional(),
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    requesterAgentId: AgentIdSchema.optional(),
    repositoryPath: z.string().min(1),
    worktreeRoot: z.string().min(1),
    baseRef: z.string().min(1).max(512),
    reviewBaseRevision: GitObjectIdSchema.optional(),
    branchName: z.string().min(1).max(512),
    requiresEnforcedBoundary: z.boolean().default(false),
  })
  .strict();
export type GitWorktreeCreateInput = z.input<typeof GitWorktreeCreateInputSchema>;

export const GitMergeInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    targetRef: z.string().min(1).max(512),
    taskId: TaskIdSchema.optional(),
    requesterAgentId: AgentIdSchema.optional(),
  })
  .strict();
export type GitMergeInput = z.input<typeof GitMergeInputSchema>;

export const GitPushInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    remote: z.string().min(1).max(128).default('origin'),
    taskId: TaskIdSchema.optional(),
    requesterAgentId: AgentIdSchema.optional(),
  })
  .strict();
export type GitPushInput = z.input<typeof GitPushInputSchema>;

export interface GitExecutor {
  run(
    cwd: string,
    args: string[],
    options?: {
      env?: Record<string, string>;
      trim?: boolean;
      maxBuffer?: number;
      timeoutMs?: number;
    },
  ): Promise<string>;
}

export type WorkspaceIdFactory = () => string;
