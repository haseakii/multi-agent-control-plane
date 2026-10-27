import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemberOverviewReader } from '../src/member-overview-reader';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function channel() {
  return {
    read: vi.fn<(signal: AbortSignal) => Promise<string>>(),
    loading: vi.fn(),
    apply: vi.fn(),
    failed: vi.fn(),
  };
}

it('polls pending member operations without globally loading or starving an in-flight read', async () => {
  const members = channel(),
    history = channel();
  let release!: (value: string) => void;
  members.read.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  history.read.mockResolvedValue('history');
  const reader = new MemberOverviewReader(members, history);
  const first = reader.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  const second = reader.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(members.read).toHaveBeenCalledTimes(1);
  expect(members.loading).not.toHaveBeenCalled();
  expect(history.loading).not.toHaveBeenCalled();
  release('completed login');
  await Promise.all([first, second]);
  expect(members.apply).toHaveBeenCalledWith('completed login');
  reader.dispose();
});

it('shows members while history hangs, then allows history recovery without replacing member configuration', async () => {
  const members = channel(),
    history = channel();
  let release!: (value: string) => void;
  members.read.mockResolvedValue('registered members');
  history.read
    .mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    )
    .mockResolvedValue('latest activity');
  const reader = new MemberOverviewReader(members, history, 100);
  const first = reader.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(members.apply).toHaveBeenCalledExactlyOnceWith('registered members');
  expect(history.apply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  await first;
  expect(history.failed.mock.calls[0]![0].message).toContain('最近执行超时');
  await reader.refresh();
  release('stale history');
  await vi.advanceTimersByTimeAsync(0);
  expect(history.apply).toHaveBeenCalledExactlyOnceWith('latest activity');
  reader.dispose();
});

it('keeps history available when the member endpoint fails and recovers with an explicit refresh', async () => {
  const members = channel(),
    history = channel();
  members.read.mockRejectedValueOnce(Error('offline')).mockResolvedValue('members recovered');
  history.read.mockResolvedValue('existing conversation');
  const reader = new MemberOverviewReader(members, history);
  await reader.refresh();
  expect(members.failed).toHaveBeenCalledTimes(1);
  expect(history.apply).toHaveBeenCalledWith('existing conversation');
  await reader.refresh();
  expect(members.apply).toHaveBeenCalledExactlyOnceWith('members recovered');
  reader.dispose();
});

it('closing or replacing the drawer cancels both reads without applying late results', async () => {
  const members = channel(),
    history = channel();
  const signals: AbortSignal[] = [];
  const releases: ((value: string) => void)[] = [];
  for (const current of [members, history])
    current.read.mockImplementation((signal) => {
      signals.push(signal);
      return new Promise((resolve) => releases.push(resolve));
    });
  const reader = new MemberOverviewReader(members, history);
  const pending = reader.refresh();
  await vi.advanceTimersByTimeAsync(0);
  reader.dispose();
  await pending;
  releases.forEach((release) => release('late'));
  await reader.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  for (const current of [members, history]) {
    expect(current.apply).not.toHaveBeenCalled();
    expect(current.failed).not.toHaveBeenCalled();
    expect(current.loading).toHaveBeenCalledTimes(1);
  }
  expect(vi.getTimerCount()).toBe(0);
});
