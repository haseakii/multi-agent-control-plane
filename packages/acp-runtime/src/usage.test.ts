import { expect, it } from 'vitest';
import { promptUsage } from './usage.js';
it('keeps reported cache zero separate from missing/null and drops opaque metadata', () => {
  expect(
    promptUsage({
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      cachedReadTokens: 0,
      cachedWriteTokens: null,
      _meta: { secret: 'hidden' },
    }),
  ).toEqual({ totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: 0 });
  expect(promptUsage(null)).toBeUndefined();
  expect(promptUsage({ cachedReadTokens: null })).toBeUndefined();
  expect(promptUsage({ cachedReadTokens: -1 })).toBeUndefined();
});
