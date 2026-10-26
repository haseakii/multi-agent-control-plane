import { z } from 'zod';
export const INPUT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const INPUT_ATTACHMENT_TOTAL_BYTES = 40 * 1024 * 1024;
export const INPUT_ATTACHMENT_DIRECTORY = '.control-plane-inputs';
export const InputAttachmentIdSchema = z.string().uuid();
export const InputAttachmentIdsSchema = z
  .array(InputAttachmentIdSchema)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate attachments.');
export const InputAttachmentSchema = z
  .object({
    id: InputAttachmentIdSchema,
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\\/\x00-\x1f\x7f]+$/),
    mimeType: z.string().min(1).max(128),
    sizeBytes: z.number().int().min(1).max(INPUT_ATTACHMENT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    image: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type InputAttachment = z.infer<typeof InputAttachmentSchema>;
