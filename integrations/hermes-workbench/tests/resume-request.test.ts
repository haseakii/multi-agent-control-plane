import { afterEach, expect, it, vi } from 'vitest';
import { resumeRequest, workspaceReadRequest } from '../src/task-request';

afterEach(() => vi.useRealTimers());

it('does not send a retry when directory preflight hangs', async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const operation = workspaceReadRequest(() => new Promise(() => {})).then(send);
  const failed = expect(operation).rejects.toThrow('尚未发送本次操作');
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('unblocks a lost retry acknowledgement without replaying or accepting a late reply', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  let finish!: (value: string) => void;
  const send = vi.fn((value: AbortSignal) => {
    signal = value;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const apply = vi.fn();
  const pending = resumeRequest(send).then(apply);
  const failed = expect(pending).rejects.toThrow('后台可能已经开始执行');
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  expect(signal.aborted).toBe(true);
  finish('accepted');
  await Promise.resolve();
  expect(send).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a confirmed failure distinct from a lost reply and clears the wait', async () => {
  vi.useFakeTimers();
  const failure = new Error('Task is already executing.');
  const send = vi.fn().mockRejectedValue(failure);
  await expect(resumeRequest(send)).rejects.toBe(failure);
  expect(send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('returns the accepted retry and leaves no timeout behind', async () => {
  vi.useFakeTimers();
  const receipt = { attemptId: 'next-attempt', state: 'running' };
  expect(await resumeRequest(async () => receipt)).toBe(receipt);
  expect(vi.getTimerCount()).toBe(0);
});
