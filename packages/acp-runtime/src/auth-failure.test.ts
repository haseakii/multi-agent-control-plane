import { expect, it } from 'vitest';
import { transientAuthenticationError } from './auth-failure.js';
it('distinguishes transient transport/internal errors from rejected or unknown authentication', () => {
  expect(transientAuthenticationError({ code: 'ETIMEDOUT' })).toBe(true);
  expect(transientAuthenticationError({ code: -32603 })).toBe(true);
  expect(transientAuthenticationError({ message: 'context deadline exceeded' })).toBe(true);
  expect(transientAuthenticationError({ code: 401, message: 'unauthorized' })).toBe(false);
  expect(transientAuthenticationError({ message: 'invalid token' })).toBe(false);
  expect(transientAuthenticationError(new Error('unknown private provider message'))).toBe(false);
});
