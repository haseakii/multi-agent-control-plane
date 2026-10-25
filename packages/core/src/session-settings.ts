import { z } from 'zod';
import { redactSensitiveText } from './sensitive-text.js';
import { AgentIdSchema, ExecutionAttemptIdSchema, TaskIdSchema } from './domain.js';

// These are public model controls, never opaque agent configuration or credentials.
const publicText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Control characters are not allowed.')
    .refine((value) => !redactSensitiveText(value).redacted, 'Sensitive text is not allowed.');

const identifier = publicText(256);
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const SessionSettingValuesSchema = z
  .record(identifier, identifier)
  .refine((values) => Object.keys(values).length <= 32, 'Too many session settings.')
  .refine((values) => byteLength(values) <= 16_384, 'Session settings exceed the byte limit.');
export type SessionSettingValues = z.infer<typeof SessionSettingValuesSchema>;

export const SessionSettingChoiceSchema = z
  .object({
    value: identifier,
    name: publicText(512),
    description: publicText(2048).optional(),
  })
  .strict();

export const SessionSettingOptionSchema = z
  .object({
    id: identifier,
    name: publicText(256),
    description: publicText(2048).optional(),
    category: publicText(128).optional(),
    type: z.literal('select'),
    currentValue: identifier,
    options: z.array(SessionSettingChoiceSchema).min(1).max(256),
  })
  .strict()
  .refine(
    (option) =>
      new Set(option.options.map((choice) => choice.value)).size === option.options.length,
    'Duplicate session setting values.',
  )
  .refine(
    (option) => option.options.some((choice) => choice.value === option.currentValue),
    'Current session setting value is not advertised.',
  );
export type SessionSettingOption = z.infer<typeof SessionSettingOptionSchema>;

export const SessionSettingsSnapshotSchema = z
  .object({
    source: z.enum(['config-options', 'legacy-models', 'unavailable']),
    options: z.array(SessionSettingOptionSchema).max(32),
  })
  .strict()
  .refine(
    (snapshot) =>
      new Set(snapshot.options.map((option) => option.id)).size === snapshot.options.length,
    'Duplicate session setting identifiers.',
  )
  .refine(
    (snapshot) => snapshot.source !== 'unavailable' || snapshot.options.length === 0,
    'Unavailable settings cannot advertise options.',
  )
  .refine((snapshot) => byteLength(snapshot) <= 65_536, 'Session settings exceed the byte limit.');
export type SessionSettingsSnapshot = z.infer<typeof SessionSettingsSnapshotSchema>;

export const AgentSessionDefaultsSchema = z
  .object({
    agentId: AgentIdSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    values: SessionSettingValuesSchema,
  })
  .strict();
export type AgentSessionDefaults = z.infer<typeof AgentSessionDefaultsSchema>;

export const TaskSessionSettingsSchema = z
  .object({
    taskId: TaskIdSchema,
    agentId: AgentIdSchema,
    requested: SessionSettingValuesSchema,
    state: z.enum(['requested', 'applied', 'failed']),
    confirmed: SessionSettingsSnapshotSchema.optional(),
    error: publicText(2000).optional(),
    attemptId: ExecutionAttemptIdSchema.optional(),
  })
  .strict();
export type TaskSessionSettings = z.infer<typeof TaskSessionSettingsSchema>;
