import { z } from 'zod';
import { AgentIdSchema, TimestampSchema } from './domain.js';
import { SessionSettingValuesSchema } from './session-settings.js';
import { redactSensitiveText } from './sensitive-text.js';

export const MAX_ACTIVE_AGENT_SESSION_PRESETS = 32;
export const MAX_TOTAL_AGENT_SESSION_PRESETS = 128;
export const AgentSessionPresetIdSchema = z.string().uuid();
export const AgentSessionPresetNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Control characters are not allowed.')
  .refine((value) => !redactSensitiveText(value).redacted, 'Sensitive text is not allowed.');
export const AgentSessionPresetRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const CreateAgentSessionPresetSchema = z
  .object({
    id: AgentSessionPresetIdSchema,
    agentId: AgentIdSchema,
    name: AgentSessionPresetNameSchema,
    values: SessionSettingValuesSchema,
  })
  .strict();
export type CreateAgentSessionPreset = z.infer<typeof CreateAgentSessionPresetSchema>;

export const UpdateAgentSessionPresetSchema = z
  .object({
    name: AgentSessionPresetNameSchema.optional(),
    values: SessionSettingValuesSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.values !== undefined,
    'No preset changes supplied.',
  );
export type UpdateAgentSessionPreset = z.infer<typeof UpdateAgentSessionPresetSchema>;

export const ListAgentSessionPresetsSchema = z
  .object({ includeArchived: z.boolean().optional() })
  .strict();

export const AgentSessionPresetSchema = CreateAgentSessionPresetSchema.extend({
  revision: AgentSessionPresetRevisionSchema,
  archived: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type AgentSessionPreset = z.infer<typeof AgentSessionPresetSchema>;
