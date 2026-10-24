import { expect, it } from 'vitest';
import { nativeTurnFailure } from './turn-failure.js';
const adapter = { name: 'antigravity-acp', version: '1.4.1' };
it('recognizes the observed pinned-adapter error sentinel, not arbitrary answer text', () => {
  expect(nativeTurnFailure(adapter, 'Internal error encountered.')).toMatchObject({
    code: 'AGENT_UPSTREAM_INTERNAL',
    retryable: true,
  });
  expect(nativeTurnFailure(adapter, 'The log said: Internal error encountered.')).toBeUndefined();
  expect(nativeTurnFailure(adapter, '"Internal error encountered."')).toBeUndefined();
  expect(
    nativeTurnFailure({ name: 'other', version: '1.4.1' }, 'Internal error encountered.'),
  ).toBeUndefined();
  expect(nativeTurnFailure(null, 'Internal error encountered.')).toBeUndefined();
});
