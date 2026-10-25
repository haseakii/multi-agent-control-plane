import { expect, it } from 'vitest';
import { canApplyNextSessionSettings } from '../src/session-setting-values';
import {
  AgentSessionSettings,
  TaskSessionSettings,
  editableSessionOptions,
  nextSessionSelection,
  sessionSettingLabel,
  sessionSettingsSummary,
  sessionSettingValuesSummary,
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
