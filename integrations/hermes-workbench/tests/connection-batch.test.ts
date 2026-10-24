import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConnectionBatch } from '../src/connection-batch';
import { memberActionRequest } from '../src/member-action-request';

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('connection batch', () => {
  it('continues later members after an individual request timeout without repeating the first', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const failed: string[] = [];
    const complete: string[] = [];
    const result = runConnectionBatch(
      ['slow', 'ready'],
      async (id) => {
        try {
          await memberActionRequest('probe', () => {
            calls.push(id);
            return id === 'slow' ? new Promise(() => {}) : Promise.resolve();
          });
          complete.push(id);
        } catch {
          failed.push(id);
        }
      },
      () => false,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({ completed: 2, total: 2, paused: false });
    expect(calls).toEqual(['slow', 'ready']);
    expect(failed).toEqual(['slow']);
    expect(complete).toEqual(['ready']);
  });

  it('honors a requested pause when the current member times out', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let pause = false;
    const result = runConnectionBatch(
      ['slow', 'untouched'],
      async (id) => {
        try {
          await memberActionRequest('probe', () => {
            calls.push(id);
            return new Promise(() => {});
          });
        } catch {
          /* The row retains its error and draft. */
        }
      },
      () => pause,
      () => {},
    );
    pause = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({ completed: 1, total: 2, paused: true });
    expect(calls).toEqual(['slow']);
  });
  it('waits for the active member before pausing and leaves later members untouched', async () => {
    const gate = deferred();
    const calls: string[] = [];
    const completed: string[] = [];
    let pause = false;
    const running = runConnectionBatch(
      ['one', 'two', 'three'],
      async (item) => {
        calls.push(item);
        await gate.promise;
        completed.push(item);
      },
      () => pause,
      () => {},
    );
    pause = true;
    expect(calls).toEqual(['one']);
    expect(completed).toEqual([]);
    gate.resolve();
    expect(await running).toEqual({ completed: 1, total: 3, paused: true });
    expect(calls).toEqual(['one']);
    expect(completed).toEqual(['one']);
    const result = await runConnectionBatch(
      ['two', 'three'],
      async (item) => {
        calls.push(item);
      },
      () => false,
      () => {},
    );
    expect(calls).toEqual(['one', 'two', 'three']);
    expect(result).toEqual({ completed: 2, total: 2, paused: false });
  });

  it('does not start a queued member if pause was requested during preparation', async () => {
    const calls: string[] = [];
    expect(
      await runConnectionBatch(
        ['one'],
        async (item) => {
          calls.push(item);
        },
        () => true,
        () => {},
      ),
    ).toEqual({ completed: 0, total: 1, paused: true });
    expect(calls).toEqual([]);
  });

  it('reports sequential progress and does not label a fully checked batch as paused', async () => {
    const states: unknown[] = [];
    let pause = false;
    const result = await runConnectionBatch(
      ['one', 'two'],
      async (item) => {
        if (item === 'two') pause = true;
      },
      () => pause,
      (state) => states.push(state),
    );
    expect(result).toEqual({ completed: 2, total: 2, paused: false });
    expect(states).toEqual([
      { completed: 0, total: 2, current: 'one' },
      { completed: 1, total: 2 },
      { completed: 1, total: 2, current: 'two' },
      { completed: 2, total: 2 },
    ]);
  });
});
