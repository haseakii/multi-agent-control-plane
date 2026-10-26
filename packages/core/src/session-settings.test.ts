import { describe, expect, it } from 'vitest';
import { SessionSettingValuesSchema, SessionSettingsSnapshotSchema } from './session-settings.js';

describe('public session setting schemas', () => {
  it('bounds values and rejects credential text without treating context token controls as secrets', () => {
    expect(SessionSettingValuesSchema.parse({ context_tokens: '128k', model: 'large' })).toEqual({
      context_tokens: '128k',
      model: 'large',
    });
    expect(SessionSettingValuesSchema.safeParse({ model: 'Bearer private-value' }).success).toBe(
      false,
    );
    expect(
      SessionSettingValuesSchema.safeParse(
        Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`setting-${index}`, 'value'])),
      ).success,
    ).toBe(false);
  });

  it('rejects snapshots whose complete public projection exceeds the byte budget', () => {
    const snapshot = {
      source: 'config-options',
      options: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: '0',
          options: Array.from({ length: 100 }, (_, index) => ({
            value: String(index),
            name: '名'.repeat(256),
          })),
        },
      ],
    };
    expect(SessionSettingsSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
