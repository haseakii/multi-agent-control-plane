import { expect, it, vi, afterEach } from 'vitest';
import {
  authenticateWithStatusRecovery,
  readCodeBuddyAuthStatus,
  supportsCodeBuddyAuthStatus,
} from './codebuddy-auth.js';
afterEach(() => vi.useRealTimers());

it('does not treat unrelated methods or unsupported status as authenticated', async () => {
  expect(
    supportsCodeBuddyAuthStatus({
      protocolVersion: 1,
      authMethods: [{ id: 'internal', name: 'Login' }],
    }),
  ).toBe(false);
  const signal = new AbortController().signal;
  expect(
    await readCodeBuddyAuthStatus(async () => {
      throw new Error('method not found');
    }, signal),
  ).toBeUndefined();
  expect(
    await readCodeBuddyAuthStatus(async () => ({ userInfo: { userId: '' } }), signal),
  ).toBeUndefined();
  const authenticate = vi.fn(async () => {}),
    read = vi.fn(async () => undefined);
  await authenticateWithStatusRecovery(authenticate, read, signal, 1);
  expect(authenticate).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});

it('requires a signed-out to signed-in transition and aborts recovery without replaying login', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const authenticate = vi.fn(() => new Promise(() => {}));
  const read = vi.fn(async () => true as boolean | undefined);
  const pending = authenticateWithStatusRecovery(authenticate, read, controller.signal, 10);
  let finished = false;
  void pending.then(
    () => {
      finished = true;
    },
    () => {},
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(finished).toBe(false); // A pre-existing session is not proof of this login.
  read.mockResolvedValueOnce(false).mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(20);
  await pending;
  expect(authenticate).toHaveBeenCalledTimes(1);
  const unknown = authenticateWithStatusRecovery(
    authenticate,
    async () => false,
    controller.signal,
    10,
  );
  const rejected = expect(unknown).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10);
  controller.abort(new Error('closed'));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds extension reads even when the peer ignores cooperative cancellation', async () => {
  const controller = new AbortController();
  const pending = readCodeBuddyAuthStatus(async () => new Promise(() => {}), controller.signal);
  controller.abort();
  expect(await pending).toBeUndefined();
});
