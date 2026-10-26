import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SnapshotRefresh } from '../src/snapshot-refresh';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

it('joins repeated polls instead of stacking requests', async () => {
  const pending = deferred();
  const read = vi.fn().mockReturnValue(pending.promise);
  const apply = vi.fn();
  const reader = new SnapshotRefresh(read, apply, vi.fn());
  const first = reader.refresh();
  expect(reader.refresh()).toBe(first);
  await vi.advanceTimersByTimeAsync(750);
  expect(reader.refresh()).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve('current');
  await first;
  expect(apply).toHaveBeenCalledExactlyOnceWith('current');
  reader.dispose();
});

it('reads after a user action immediately and ignores the old response even when abort is ignored', async () => {
  const old = deferred();
  const apply = vi.fn(),
    report = vi.fn();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('after-action');
  const reader = new SnapshotRefresh(read, apply, report);
  const first = reader.refresh();
  await vi.advanceTimersByTimeAsync(0);
  const oldSignal = read.mock.calls[0]![0] as AbortSignal;
  await reader.refresh(true);
  expect(oldSignal.aborted).toBe(true);
  old.resolve('before-action');
  await first;
  expect(apply).toHaveBeenCalledExactlyOnceWith('after-action');
  expect(report).not.toHaveBeenCalled();
  reader.dispose();
});

it('releases a hung read at the deadline and permits recovery without accepting its late result', async () => {
  const old = deferred();
  const apply = vi.fn(),
    report = vi.fn();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('recovered');
  const reader = new SnapshotRefresh(read, apply, report);
  const first = reader.refresh();
  await vi.advanceTimersByTimeAsync(15_000);
  await first;
  expect(report.mock.calls[0]![0].message).toContain('超时');
  expect(apply).not.toHaveBeenCalled();
  await reader.refresh();
  old.resolve('expired');
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledExactlyOnceWith('recovered');
  reader.dispose();
});

it('cancels on unmount and never changes the replacement page', async () => {
  const old = deferred();
  const apply = vi.fn(),
    report = vi.fn();
  const read = vi.fn().mockReturnValue(old.promise);
  const reader = new SnapshotRefresh(read, apply, report);
  const pending = reader.refresh();
  await vi.advanceTimersByTimeAsync(0);
  reader.dispose();
  await pending;
  old.resolve('unmounted');
  await reader.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
