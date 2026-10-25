import { z } from 'zod';
import { AgentIdSchema, ExecutionAttemptIdSchema, TaskIdSchema } from './domain.js';

export const ProxyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((raw) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`))
  .superRefine((raw, ctx) => {
    try {
      const url = new URL(raw);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        /[\u0000-\u0020\u007f]/u.test(raw)
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Use an HTTP(S) proxy host and port without credentials, paths or queries.',
      });
    }
  })
  .transform((raw) => new URL(raw).origin);
const bypass = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(?:\.?[a-zA-Z0-9][a-zA-Z0-9.-]*|\[?[a-fA-F0-9:]+\]?)$/),
  )
  .max(64);
const fields = { proxyUrl: ProxyUrlSchema.optional(), bypass: bypass.default([]) };
export const GlobalNetworkChoiceSchema = z
  .object({ mode: z.enum(['unmanaged', 'direct', 'proxy']), ...fields })
  .strict()
  .refine((value) => value.mode !== 'proxy' || !!value.proxyUrl, 'A proxy address is required.');
export const AgentNetworkChoiceSchema = z
  .object({ mode: z.enum(['inherit', 'direct', 'proxy']), ...fields })
  .strict()
  .refine((value) => value.mode !== 'proxy' || !!value.proxyUrl, 'A proxy address is required.');
export const NetworkSettingsInputSchema = z
  .object({
    global: GlobalNetworkChoiceSchema,
    members: z
      .record(AgentIdSchema, AgentNetworkChoiceSchema)
      .refine((v) => Object.keys(v).length <= 128),
  })
  .strict();
export const NetworkSettingsSchema = NetworkSettingsInputSchema.extend({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime().nullable(),
}).strict();
export const SaveNetworkSettingsSchema = NetworkSettingsInputSchema.extend({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const EffectiveNetworkSchema = z
  .object({
    agentId: AgentIdSchema.optional(),
    source: z.enum(['global', 'member', 'existing']),
    mode: z.enum(['unmanaged', 'direct', 'proxy']),
    proxyUrl: ProxyUrlSchema.optional(),
    bypass,
    revision: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    enforcementMode: z.enum(['enforced', 'cooperative', 'unavailable']),
    boundary: z.enum(['agent-environment', 'control-plane-http']),
  })
  .strict();
export const ExecutionNetworkObservationSchema = z
  .object({
    attemptId: ExecutionAttemptIdSchema,
    taskId: TaskIdSchema,
    agentId: AgentIdSchema,
    effective: EffectiveNetworkSchema,
    observedAt: z.string().datetime(),
    state: z.enum(['prepared', 'started']),
    trafficVerified: z.literal(false),
  })
  .strict();
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;
export type NetworkSettingsInput = z.infer<typeof NetworkSettingsInputSchema>;
export type EffectiveNetwork = z.infer<typeof EffectiveNetworkSchema>;
export type ExecutionNetworkObservation = z.infer<typeof ExecutionNetworkObservationSchema>;
