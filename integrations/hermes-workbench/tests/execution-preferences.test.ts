import { expect, it } from 'vitest';
import {
  chooseExecutionMode,
  chooseMember,
  executionPreferencesKey,
  fillInitialMember,
  readExecutionPreferences,
  writeExecutionPreferences,
} from '../src/execution-preferences';

it('keeps separate member selections across mode changes and browser reload', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let preferences = chooseMember(
    readExecutionPreferences(() => store),
    'worker',
  );
  preferences = chooseExecutionMode(preferences, 'collaborative', ['leader']);
  writeExecutionPreferences(preferences, () => store);
  const restored = readExecutionPreferences(() => store);
  expect(restored.mode).toBe('collaborative');
  expect(restored.members).toEqual({ direct: 'worker', collaborative: 'leader' });
  expect(chooseExecutionMode(restored, 'direct', ['alternative']).members.direct).toBe('worker');
  expect(Object.keys(JSON.parse(values.get(executionPreferencesKey)!)).sort()).toEqual([
    'members',
    'mode',
    'version',
  ]);
});

it('never silently replaces an unavailable, removed or ineligible selected member', () => {
  const chosen = chooseMember(
    readExecutionPreferences(() => {
      throw Error('storage blocked');
    }),
    'chosen',
  );
  expect(fillInitialMember(chosen, [])).toBe(chosen);
  expect(fillInitialMember(chosen, ['other'])).toBe(chosen);
  expect(fillInitialMember(chosen, ['other', 'chosen'])).toBe(chosen);
  expect(chooseMember(chosen, 'other').members.direct).toBe('other');
});

it('fills a fresh selection when the first eligible member becomes available', () => {
  const initial = readExecutionPreferences(() => ({ getItem: () => null, setItem: () => {} }));
  expect(fillInitialMember(initial, [])).toBe(initial);
  expect(fillInitialMember(initial, ['ready']).members.direct).toBe('ready');
});

it('invalid or unavailable browser storage cannot block opening or selecting members', () => {
  for (const raw of [
    'invalid',
    '{}',
    JSON.stringify({
      version: 1,
      mode: 'direct',
      members: { direct: 'x', collaborative: '' },
      permissions: 'auto',
    }),
  ]) {
    expect(
      readExecutionPreferences(() => ({ getItem: () => raw, setItem: () => {} })).members.direct,
    ).toBe('');
  }
  expect(() =>
    writeExecutionPreferences(
      chooseMember(
        readExecutionPreferences(() => {
          throw Error('blocked');
        }),
        'worker',
      ),
      () => {
        throw Error('quota');
      },
    ),
  ).not.toThrow();
});
