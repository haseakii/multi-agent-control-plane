import { z } from 'zod';
import { MessageIdSchema, ProjectIdSchema, TaskIdSchema, TimestampSchema } from './domain.js';

/** Operator-facing projection; a completed ACP turn does not prove semantic understanding. */
export const MessageDeliveryViewSchema = z
  .object({
    messageId: MessageIdSchema,
    projectId: ProjectIdSchema,
    state: z.enum(['unavailable', 'pending', 'delivering', 'delivered', 'cancelled']),
    reason: z.enum([
      'unavailable',
      'queued',
      'retry_delay',
      'processing',
      'lease_expired',
      'recipient_stopped',
      'recipient_approval',
      'recipient_terminal',
      'recipient_unresolved',
      'acknowledged',
      'cancelled',
    ]),
    recipientTaskId: TaskIdSchema.optional(),
    attemptCount: z.number().int().nonnegative().optional(),
    availableAt: TimestampSchema.optional(),
    leaseUntil: TimestampSchema.optional(),
    deliveredAt: TimestampSchema.optional(),
    hasPreviousFailure: z.boolean().optional(),
  })
  .strict();
export type MessageDeliveryView = z.infer<typeof MessageDeliveryViewSchema>;
