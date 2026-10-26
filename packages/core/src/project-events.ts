import { z } from 'zod';
import { AuditEventSchema } from './domain.js';

export const PROJECT_EVENT_PAGE_LIMIT = 100;
export const ProjectEventNoticeSchema = AuditEventSchema.pick({
  id: true,
  projectId: true,
  taskId: true,
  type: true,
  occurredAt: true,
});
export type ProjectEventNotice = z.infer<typeof ProjectEventNoticeSchema>;
export const ProjectEventReadSchema = z
  .object({
    after: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(PROJECT_EVENT_PAGE_LIMIT).default(PROJECT_EVENT_PAGE_LIMIT),
  })
  .strict();
export type ProjectEventRead = z.input<typeof ProjectEventReadSchema>;
export const ProjectEventPageSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('events'),
      events: z.array(ProjectEventNoticeSchema).max(PROJECT_EVENT_PAGE_LIMIT),
    })
    .strict(),
  z
    .object({
      status: z.literal('reset'),
      cursor: ProjectEventNoticeSchema.shape.id.optional(),
    })
    .strict(),
]);
export type ProjectEventPage = z.infer<typeof ProjectEventPageSchema>;

/** Read-only, append-ordered notifications. Payloads remain in the ordinary audit repository.
 * Missing/foreign cursors reset to the current tail; an absent cursor reads from the beginning.
 * Implementations may be synchronous or asynchronous and must bound each page.
 */
export interface ProjectEventReader {
  latest(projectId: string): string | undefined | Promise<string | undefined>;
  readAfter(
    projectId: string,
    query: ProjectEventRead,
  ): ProjectEventPage | Promise<ProjectEventPage>;
}
