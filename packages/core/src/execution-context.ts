import { z } from 'zod';
import { ProjectMemorySchema } from './project-memory.js';

const taskSummary = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    objective: z.string(),
    state: z.string(),
    resultArtifactRefs: z.array(z.string()),
  })
  .strict();

/** A versioned snapshot of selected inputs, independent of ACP conversation history. */
export const ExecutionContextSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().min(1),
    assignmentId: z.string().min(1),
    attemptId: z.string().min(1),
    project: z
      .object({ id: z.string(), name: z.string(), description: z.string().optional() })
      .strict(),
    task: taskSummary,
    acceptedMemory: z.array(ProjectMemorySchema).max(16).default([]),
    parent: taskSummary.optional(),
    dependencies: z.array(taskSummary).max(16),
    completedChildren: z.array(taskSummary).max(16),
    workspace: z
      .object({
        id: z.string(),
        provider: z.string(),
        rootPath: z.string(),
        access: z.string(),
        baseRevision: z.string().optional(),
        branchName: z.string().optional(),
      })
      .strict(),
    previousAttempts: z
      .array(
        z
          .object({
            id: z.string(),
            state: z.string(),
            failure: z.string().optional(),
          })
          .strict(),
      )
      .max(3),
    artifacts: z
      .array(
        z
          .object({
            id: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            mimeType: z.string(),
            sizeBytes: z.number().int().nonnegative(),
            source: z.enum(['selected', 'dependency', 'previous-result']),
            content: z.string().optional(),
            contentOmitted: z.string().optional(),
          })
          .strict(),
      )
      .max(32),
    notes: z.array(z.string()),
  })
  .strict();
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;
