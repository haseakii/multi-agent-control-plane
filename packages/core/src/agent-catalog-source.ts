import { z } from 'zod';
import { AgentIdSchema } from './domain.js';
import { redactSensitiveText } from './sensitive-text.js';

const publicText = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/u.test(value) && !redactSensitiveText(value).redacted,
    );

/** Registration provenance is a user-selected catalog association, never execution authority. */
export const AgentCatalogSourceInputSchema = z
  .object({
    entryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9-]*$/),
    entryName: publicText(256),
    catalogVersion: publicText(128),
    catalogUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      }),
  })
  .strict();
export type AgentCatalogSourceInput = z.infer<typeof AgentCatalogSourceInputSchema>;

export const AgentCatalogSourceSchema = AgentCatalogSourceInputSchema.extend({
  agentId: AgentIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  runtimeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentCatalogSource = z.infer<typeof AgentCatalogSourceSchema>;

export const AgentCatalogSourceViewSchema = z
  .object({
    status: z.enum(['linked', 'entry-changed', 'unavailable']),
    record: AgentCatalogSourceSchema.nullable(),
  })
  .strict()
  .refine((value) =>
    value.status === 'unavailable' ? value.record === null : value.record !== null,
  );
export type AgentCatalogSourceView = z.infer<typeof AgentCatalogSourceViewSchema>;
