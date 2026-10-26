import { z } from 'zod';
export const InputAttachment = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  image: z.boolean(),
  createdAt: z.string(),
});
export type InputAttachmentData = z.infer<typeof InputAttachment>;
export const AttachmentIds = z.array(z.string().uuid()).max(10);
export const sameAttachmentIds = (left?: string[], right?: string[]) =>
  JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
export const attachmentUrl = (id: string) =>
  `/api/input-attachments/${encodeURIComponent(id)}/content`;
export const attachmentText = (attachments: InputAttachmentData[]) =>
  attachments.length
    ? '\n\n附件：\n' +
      attachments
        .map((a) => {
          const label = a.name.replace(/[\\[\]`!*_]/g, '\\$&');
          return a.image
            ? `![${label}](${attachmentUrl(a.id)})`
            : `[${label} · ${(a.sizeBytes / 1024).toFixed(1)} KB](${attachmentUrl(a.id)})`;
        })
        .join('\n\n')
    : '';
