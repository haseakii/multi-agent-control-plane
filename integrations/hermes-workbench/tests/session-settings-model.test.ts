import { expect, it } from 'vitest';
import { canApplyNextSessionSettings } from '../src/session-setting-values';
import {
  AgentSessionSettings,
  AgentSessionPresets,
  SessionPreset,
  TaskSessionSettings,
  editableSessionOptions,
  nextSessionSelection,
  sessionSettingLabel,
  sessionSettingsSummary,
  sessionSettingValuesSummary,
  sessionCacheFreshness,
  sessionPresetDraft,
  type SessionSettingOptionData,
} from '../src/session-settings-model';

const option = (id: string, category?: string): SessionSettingOptionData => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue: 'a',
  options: [
    { value: 'a', name: '选项 A' },
    { value: 'b', name: '选项 B' },
  ],
});

it('marks expired or invalidated observations stale without changing cached options or old task confirmations', () => {
  const data = AgentSessionSettings.parse({
    agentId: 'member-a',
    settings: { source: 'config-options', options: [option('model')] },
    defaults: { revision: 1, values: { model: 'b' } },
    freshness: 'fresh',
    staleReason: null,
    observation: {
      source: 'acp-session-new',
      observedAt: '2026-10-25T01:00:00.000Z',
      expiresAt: '2026-10-25T01:05:00.000Z',
      sessionIdHash: 'probe-hash',
      definitionFingerprint: 'definition-hash',
      readinessFingerprint: 'ready-hash',
      accountIdentity: 'not-exposed',
      accountIdentityNote: '仅绑定可观察就绪证据。',
    },
  });
  expect(sessionCacheFreshness(data, Date.parse('2026-10-25T01:04:59.000Z'))).toBe('fresh');
  expect(sessionCacheFreshness(data, Date.parse('2026-10-25T01:05:00.000Z'))).toBe('stale');
  expect(
    sessionCacheFreshness(
      { ...data, freshness: 'stale', staleReason: 'readiness-changed' },
      Date.parse('2026-10-25T01:01:00.000Z'),
    ),
  ).toBe('stale');
  expect(data.settings?.options[0]?.currentValue).toBe('a');
  expect(
    TaskSessionSettings.parse({
      state: 'applied',
      requested: { model: 'a' },
      confirmed: data.settings,
    }).state,
  ).toBe('applied');
});

it('does not call an unobserved legacy cache fresh or invent account identity', () => {
  const missing = AgentSessionSettings.parse({
    agentId: 'a',
    settings: null,
    defaults: { revision: 0, values: {} },
  });
  expect(sessionCacheFreshness(missing)).toBe('unavailable');
  expect(missing.observation).toBeNull();
});

it('loads a named preset as a detached parameter draft, leaving the preset and defaults unchanged', () => {
  const preset = SessionPreset.parse({
    id: 'e838f9c3-f7de-4b14-bd12-c17b409c58c6',
    agentId: 'member-a',
    name: ' 日常开发 ',
    revision: 3,
    values: { model: 'a', reasoning_effort: 'high' },
    archived: false,
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:01:00.000Z',
  });
  const draft = sessionPresetDraft(preset);
  draft.model = 'b';
  expect(preset.name).toBe('日常开发');
  expect(preset.values.model).toBe('a');
  expect(preset.revision).toBe(3);
});

it('accepts archived records for recovery but rejects an oversized preset response', () => {
  const archived = SessionPreset.parse({
    id: 'e838f9c3-f7de-4b14-bd12-c17b409c58c6',
    agentId: 'member-a',
    name: '旧方案',
    revision: 2,
    values: {},
    archived: true,
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:01:00.000Z',
  });
  expect(
    AgentSessionPresets.parse({ agentId: 'member-a', presets: [archived] }).presets[0]?.archived,
  ).toBe(true);
  expect(
    AgentSessionPresets.safeParse({ agentId: 'member-a', presets: Array(129).fill(archived) })
      .success,
  ).toBe(false);
});

it('keeps running instructions and terminal cleanup on the frozen settings until execution truly ends', () => {
  expect(canApplyNextSessionSettings(false, true)).toBe(false);
  expect(canApplyNextSessionSettings(false, false)).toBe(false);
  expect(canApplyNextSessionSettings(true, true)).toBe(false);
  expect(canApplyNextSessionSettings(true, false)).toBe(true);
});

it('renders old tasks without settings records as unavailable, while requiring execution records to include requested values', () => {
  expect(TaskSessionSettings.parse({ state: 'unavailable' })).toEqual({
    state: 'unavailable',
    requested: {},
  });
  expect(TaskSessionSettings.safeParse({ state: 'applied' }).success).toBe(false);
  expect(
    AgentSessionSettings.parse({
      agentId: 'a',
      settings: null,
      defaults: { revision: 0, values: {} },
    }).settings,
  ).toBeNull();
});

it('accepts advertised category-less model controls and keeps unrelated or dangerous selectors out', () => {
  const settings = {
    source: 'config-options' as const,
    options: [
      option('model'),
      option('reasoning_effort'),
      option('thinking_level'),
      option('context_size', 'model_config'),
      option('unknown'),
      option('mode'),
      option('approval_policy', 'model_config'),
      option('sandbox', 'model'),
    ],
  };
  expect(editableSessionOptions(settings).map((item) => item.id)).toEqual([
    'model',
    'reasoning_effort',
    'thinking_level',
    'context_size',
  ]);
  expect(sessionSettingLabel(settings.options[0]!)).toBe('模型');
  expect(sessionSettingLabel(settings.options[1]!)).toBe('思考等级');
  expect(sessionSettingsSummary(settings)).toContain('模型：选项 A');
});

it('re-reads dependent options after changing a model without sending stale reasoning choices', () => {
  const selected = { model: 'a', reasoning_effort: 'high', context_size: 'large' };
  expect(nextSessionSelection(option('model'), selected, 'b')).toEqual({ model: 'b' });
  expect(nextSessionSelection(option('reasoning_effort'), selected, 'low')).toEqual({
    ...selected,
    reasoning_effort: 'low',
  });
});

it('shows selected values using cached labels rather than the last confirmed current values', () => {
  const cached = {
    source: 'config-options' as const,
    options: [option('model'), option('reasoning_effort')],
  };
  expect(sessionSettingValuesSummary({ model: 'b', reasoning_effort: 'b' }, cached)).toBe(
    '模型：选项 B · 思考等级：选项 B',
  );
  expect(sessionSettingValuesSummary({ model: 'new-model', reasoning_effort: 'low' })).toBe(
    '模型：new-model · 思考等级：low',
  );
});
