import { afterEach, expect, it, vi } from 'vitest';
import { memberActionRequest } from '../src/member-action-request';

afterEach(() => vi.useRealTimers());

it('never starts a member operation if its activity preflight does not return', async () => {
  vi.useFakeTimers();
  const post = vi.fn();
  const operation = memberActionRequest('activity', () => new Promise(() => {})).then(post);
  const failed = expect(operation).rejects.toThrow('尚未发起连接或登录');
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  expect(post).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a hung probe, aborts only the HTTP wait, and never retries or accepts a late reply', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  let finish!: (value: string) => void;
  const request = vi.fn((value: AbortSignal) => {
    signal = value;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const apply = vi.fn();
  const operation = memberActionRequest('probe', request).then(apply);
  const failed = expect(operation).rejects.toThrow('后台可能仍在处理');
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  finish('late success');
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('allows the full agent login window, then reports uncertainty instead of login failure', async () => {
  vi.useFakeTimers();
  const settled = vi.fn();
  const operation = memberActionRequest('auth', () => new Promise(() => {}));
  void operation.then(settled, settled);
  const failed = expect(operation).rejects.toThrow('登录结果尚未确认');
  await vi.advanceTimersByTimeAsync(300_000);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it('returns successful observations and preserves backend diagnostics without an automatic retry', async () => {
  vi.useFakeTimers();
  const observation = { readiness: { auth: 'ready', runtime: 'ready' } };
  expect(await memberActionRequest('probe', async () => observation)).toBe(observation);
  const failure = Error('HTTP 409: Member busy');
  const request = vi.fn().mockRejectedValue(failure);
  await expect(memberActionRequest('probe', request)).rejects.toBe(failure);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
