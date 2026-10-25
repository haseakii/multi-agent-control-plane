import { z } from 'zod';
import { SessionSettingValues, type SessionSettingValuesData } from './session-setting-values';

export const SessionSettings = z.object({
  source: z.enum(['config-options', 'legacy-models', 'unavailable']),
  options: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      type: z.literal('select'),
      currentValue: z.string(),
      options: z.array(
        z.object({ value: z.string(), name: z.string(), description: z.string().optional() }),
      ),
    }),
  ),
});
export type SessionSettingsData = z.infer<typeof SessionSettings>;
export type SessionSettingOptionData = SessionSettingsData['options'][number];
export const AgentSessionSettings = z.object({
  agentId: z.string(),
  projectId: z.string().optional(),
  settings: SessionSettings.nullable(),
  defaults: z.object({ revision: z.number().int().nonnegative(), values: SessionSettingValues }),
});
export type AgentSessionSettingsData = z.infer<typeof AgentSessionSettings>;
export const TaskSessionSettings = z.union([
  z.object({
    state: z.literal('unavailable'),
    requested: SessionSettingValues.default({}),
    confirmed: SessionSettings.optional(),
    error: z.string().optional(),
  }),
  z.object({
    state: z.enum(['requested', 'applied', 'failed']),
    requested: SessionSettingValues,
    confirmed: SessionSettings.optional(),
    error: z.string().optional(),
  }),
]);
export type TaskSessionSettingsData = z.infer<typeof TaskSessionSettings>;

function optionKind(option: SessionSettingOptionData) {
  if (
    /(?:permission|approval|sandbox|authorization|credential|execution_policy|access_policy)/iu.test(
      option.id,
    ) ||
    ['mode', 'session_mode', 'collaboration_mode'].includes(option.id)
  )
    return undefined;
  if (option.category)
    return ['model', 'thought_level', 'model_config'].includes(option.category)
      ? option.category
      : undefined;
  if (option.id === 'model') return 'model';
  if (['thought_level', 'reasoning_effort', 'thinking_level'].includes(option.id))
    return 'thought_level';
  return undefined;
}

/** Mirrors the protocol adapter's safe model-controls allowlist, including older peers. */
export function editableSessionOptions(settings: SessionSettingsData) {
  return settings.options.filter((option) => optionKind(option) !== undefined);
}
export function sessionSettingLabel(option: SessionSettingOptionData) {
  const kind = optionKind(option);
  return kind === 'model' ? '模型' : kind === 'thought_level' ? '思考等级' : option.name;
}
export function currentSessionValues(settings: SessionSettingsData): SessionSettingValuesData {
  return Object.fromEntries(
    editableSessionOptions(settings).map((option) => [option.id, option.currentValue]),
  );
}
export function sessionSettingsSummary(settings: SessionSettingsData) {
  return editableSessionOptions(settings)
    .map(
      (option) =>
        `${sessionSettingLabel(option)}：${option.options.find((choice) => choice.value === option.currentValue)?.name ?? option.currentValue}`,
    )
    .join(' · ');
}
export function sessionSettingValuesSummary(
  values: SessionSettingValuesData,
  cached?: SessionSettingsData | null,
) {
  const options = cached ? editableSessionOptions(cached) : [];
  return Object.entries(values)
    .map(([id, value]) => {
      const option = options.find((item) => item.id === id);
      const label = option
        ? sessionSettingLabel(option)
        : id === 'model'
          ? '模型'
          : ['thought_level', 'reasoning_effort', 'thinking_level'].includes(id)
            ? '思考等级'
            : id;
      return `${label}：${option?.options.find((choice) => choice.value === value)?.name ?? value}`;
    })
    .join(' · ');
}
export function nextSessionSelection(
  option: SessionSettingOptionData,
  selected: SessionSettingValuesData,
  value: string,
): SessionSettingValuesData {
  // A model change invalidates dependent reasoning/configuration choices.
  return optionKind(option) === 'model'
    ? { [option.id]: value }
    : { ...selected, [option.id]: value };
}
