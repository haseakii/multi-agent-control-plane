import { z } from 'zod';

/** One runtime contract for native MCP and HTTP-proxied messaging. */
export const FleetSendMessageSchema = z
  .object({
    targetAgentId: z.string().min(1).max(128),
    targetTaskId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Select an active task owned by the recipient in this project. Required when multiple tasks are active; never starts a different task.',
      ),
    taskId: z.string().min(1).max(128).optional(),
    type: z.enum(['request', 'response', 'message', 'handoff', 'event', 'status']),
    content: z.string().optional(),
    artifactRefs: z.array(z.string().min(1).max(128)).optional(),
    replyTo: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('Reply to a message received by this task; routes to its original sender task.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Reuse with the same input to retry one logical send from this task. Changed input conflicts.',
      ),
  })
  .strict();
