import { z } from 'zod';
import {
  ProjectIdSchema,
  TaskIdSchema,
  ExecutionAttemptIdSchema,
  TimestampSchema,
} from './domain.js';

export const SubmitTaskInstructionSchema = z
  .object({
    content: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

export const TaskInstructionSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().min(1).max(128),
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema,
    actor: z.union([
      z.object({ type: z.literal('user'), id: z.literal('local-operator') }).strict(),
      z
        .object({ type: z.literal('agent'), id: z.string().regex(/^mcp-client:.{1,128}$/) })
        .strict(),
    ]),
    content: z.string().min(1).max(4000),
    idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['queued', 'claimed', 'delivered']),
    ownerAttemptId: ExecutionAttemptIdSchema.optional(),
    deliveredAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((instruction, context) => {
    if ((instruction.state === 'queued') !== (instruction.ownerAttemptId === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Instruction ownership does not match its state.',
      });
    if ((instruction.state === 'delivered') !== (instruction.deliveredAt !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'Instruction acknowledgement does not match its state.',
      });
  });
export type TaskInstruction = z.infer<typeof TaskInstructionSchema>;

export const TaskInstructionSnapshotSchema = z
  .object({
    instructions: z.array(TaskInstructionSchema),
    canSubmit: z.boolean(),
    reason: z.enum([
      'active',
      'task_ended',
      'not_executing',
      'finishing',
      'stopping',
      'owner_changed',
    ]),
    activeAttemptId: ExecutionAttemptIdSchema.optional(),
  })
  .strict();
