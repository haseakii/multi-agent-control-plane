import {
  SessionSettingOptionSchema,
  SessionSettingsSnapshotSchema,
  type SessionSettingOption,
  type SessionSettingsSnapshot,
} from '@control-plane/core';
import { z } from 'zod';

export const unavailableSessionSettings = (): SessionSettingsSnapshot => ({
  source: 'unavailable',
  options: [],
});

/** Host-generated observation metadata stays separate from a task's actual model snapshot. */
export const SessionSettingsInspectionSchema = z
  .object({
    settings: SessionSettingsSnapshotSchema,
    observation: z
      .object({
        source: z.literal('acp-session-new'),
        observedAt: z.string().datetime(),
        sessionIdHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export type SessionSettingsInspection = z.infer<typeof SessionSettingsInspectionSchema>;

const messages = {
  'invalid-advertisement': 'Agent returned invalid or excessive session settings.',
  'invalid-values': 'Requested session settings are invalid.',
  'unsupported-option': 'A requested session setting is not advertised by this agent.',
  'invalid-value': 'A requested setting value is not available for the selected model.',
  rejected: 'Agent rejected the requested session setting.',
  unconfirmed: 'Agent did not confirm the requested session setting. No prompt was sent.',
  busy: 'Session settings cannot change while this session is running.',
  closed: 'Session settings cannot change after the connection has closed.',
} as const;

/** Errors contain fixed diagnostics and the last confirmed public state, never provider errors. */
export class AcpSessionSettingsError extends Error {
  readonly snapshot: SessionSettingsSnapshot;

  constructor(
    readonly code: keyof typeof messages,
    snapshot: SessionSettingsSnapshot = unavailableSessionSettings(),
  ) {
    super(messages[code]);
    this.name = 'AcpSessionSettingsError';
    this.snapshot = structuredClone(snapshot);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const metadata = z.object({
  id: z.string().max(256),
  name: z.string().max(256),
  description: z.string().max(2048).nullish(),
  category: z.string().max(128).nullish(),
  type: z.string().max(64),
});
const choice = z.object({
  value: z.string().max(256),
  name: z.string().max(256),
  description: z.string().max(2048).nullish(),
});
const group = z.object({
  group: z.string().max(256),
  name: z.string().max(256),
  options: z.array(choice).min(1).max(256),
});

function isModelControl(option: z.infer<typeof metadata>): boolean {
  if (
    /(?:permission|approval|sandbox|authorization|credential|execution_policy|access_policy)/iu.test(
      option.id,
    ) ||
    ['mode', 'session_mode', 'collaboration_mode'].includes(option.id)
  )
    return false;
  if (option.category != null)
    return ['model', 'thought_level', 'model_config'].includes(option.category);
  // Older peers omitted the semantic category. Only these unambiguous standard controls
  // are recognized; an unknown selector never becomes a writable model control.
  return ['model', 'thought_level', 'reasoning_effort', 'thinking_level'].includes(option.id);
}

function description(value: string | null | undefined): { description?: string } {
  return value ? { description: value } : {};
}

export type KnownModel = {
  value: string;
  name: string;
  description?: string;
};

export const ANTIGRAVITY_KNOWN_MODELS: readonly KnownModel[] = [
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  {
    value: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    description: 'Google AI Pro / Gemini Enterprise',
  },
  {
    value: 'claude-opus-4.6',
    name: 'Claude Opus 4.6 (Thinking)',
    description: 'Google AI Pro / Gemini Enterprise',
  },
  {
    value: 'gpt-oss-120b',
    name: 'GPT-OSS 120B (Medium)',
    description: 'Google AI Pro / Gemini Enterprise',
  },
  {
    value: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    description: 'Google AI Pro / Gemini Enterprise',
  },
];

function configOptionsSnapshot(
  value: unknown,
  agentInfo?: { name?: string; version?: string } | null,
): SessionSettingsSnapshot {
  const raw = z.array(z.unknown()).max(64).parse(value);
  const options: SessionSettingOption[] = [];
  for (const input of raw) {
    const base = metadata.parse(input);
    if (base.type !== 'select' || !isModelControl(base)) continue;
    const item = record(input)!;
    const variants = z.array(z.unknown()).min(1).max(256).parse(item.options);
    const flattened = variants.flatMap((variant) => {
      if (record(variant)?.group !== undefined) {
        const parsed = group.parse(variant);
        return parsed.options.map((entry) => ({
          value: entry.value,
          name: `${parsed.name} · ${entry.name}`,
          ...description(entry.description),
        }));
      }
      const entry = choice.parse(variant);
      return [{ value: entry.value, name: entry.name, ...description(entry.description) }];
    });
    if (
      (base.id === 'model' || base.category === 'model') &&
      (agentInfo?.name === 'antigravity-acp' ||
        flattened.some((candidate) => candidate.value.includes('gemini-3.8-flash')))
    ) {
      for (const known of ANTIGRAVITY_KNOWN_MODELS) {
        if (!flattened.some((candidate) => candidate.value === known.value)) {
          flattened.push({
            value: known.value,
            name: known.name,
            ...description(known.description),
          });
        }
      }
    }
    options.push(
      SessionSettingOptionSchema.parse({
        id: base.id,
        name: base.name,
        ...description(base.description),
        ...(base.category ? { category: base.category } : {}),
        type: 'select',
        currentValue: item.currentValue,
        options: flattened,
      }),
    );
  }
  return SessionSettingsSnapshotSchema.parse({ source: 'config-options', options });
}

function legacyModelsSnapshot(value: unknown): SessionSettingsSnapshot {
  const models = z
    .object({
      currentModelId: z.string().max(256),
      availableModels: z
        .array(
          z.object({
            modelId: z.string().max(256),
            name: z.string().max(256),
            description: z.string().max(2048).nullish(),
          }),
        )
        .min(1)
        .max(256),
    })
    .parse(value);
  return SessionSettingsSnapshotSchema.parse({
    source: 'legacy-models',
    options: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: models.currentModelId,
        options: models.availableModels.map((model) => ({
          value: model.modelId,
          name: model.name,
          ...description(model.description),
        })),
      },
    ],
  });
}

/** Whitelist known public selectors; discard opaque metadata and permission/session modes. */
export function sessionSettingsFromResponse(
  response: unknown,
  agentInfo?: { name?: string; version?: string } | null,
): SessionSettingsSnapshot {
  try {
    const input = record(response);
    const meta = record(input?._meta);
    const isAntigravity =
      agentInfo?.name === 'antigravity-acp' || (meta && record(meta.antigravity) !== undefined);
    const effectiveAgentInfo = isAntigravity
      ? { name: 'antigravity-acp', ...(agentInfo?.version ? { version: agentInfo.version } : {}) }
      : agentInfo;
    if (input?.configOptions != null) {
      const settings = configOptionsSnapshot(input.configOptions, effectiveAgentInfo);
      // Some peers advertise an empty (or permission-only) modern list alongside
      // the older model interface. Keep using that model interface in this case.
      if (settings.options.length || input.models == null) return settings;
    }
    if (input?.models != null) return legacyModelsSnapshot(input.models);
    return unavailableSessionSettings();
  } catch {
    throw new AcpSessionSettingsError('invalid-advertisement');
  }
}

export function legacyModelUpdate(
  snapshot: SessionSettingsSnapshot,
  value: unknown,
): SessionSettingsSnapshot {
  try {
    if (snapshot.source !== 'legacy-models') return snapshot;
    return SessionSettingsSnapshotSchema.parse({
      ...snapshot,
      options: snapshot.options.map((option) => ({ ...option, currentValue: value })),
    });
  } catch {
    throw new AcpSessionSettingsError('invalid-advertisement', snapshot);
  }
}
