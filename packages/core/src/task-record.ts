import { z } from 'zod';
import { TaskSchema } from './domain.js';
import { InputAttachmentIdsSchema } from './input-attachments.js';

export const TaskDraftInputSchema = z
  .object({
    attachmentIds: InputAttachmentIdsSchema.optional(),
    title: z.string().trim().min(1).max(256).optional(),
    objective: z.string().trim().min(1).max(100_000),
  })
  .strict();
export const TaskRecordConfirmationSchema = z
  .object({
    version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const TaskRecordUpdateSchema = TaskRecordConfirmationSchema.extend({
  title: z.string().trim().min(1).max(256).optional(),
  objective: z.string().trim().min(1).max(100_000).optional(),
})
  .strict()
  .refine((value) => value.title !== undefined || value.objective !== undefined);
export const TaskRecordViewSchema = z
  .object({
    task: TaskSchema,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    canEditObjective: z.boolean(),
    canDelete: z.boolean(),
    reason: z.string(),
  })
  .strict();
export type TaskRecordView = z.infer<typeof TaskRecordViewSchema>;
