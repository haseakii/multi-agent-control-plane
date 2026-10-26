import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { LocalRunner } from './local-runner.js';

it('rejects a failed stdin write and consumes its separate pipe error event during cleanup', async () => {
  const runner = new LocalRunner({ defaultStopGracePeriodMs: 50 });
  const handle = await runner.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
  });
  const child = vi.mocked(spawn).mock.results[0]!.value;
  const failure = Object.assign(new Error('closed stdin pipe'), { code: 'EPIPE' });
  try {
    vi.spyOn(child.stdin, 'write').mockImplementationOnce((_chunk: unknown, callback: unknown) => {
      queueMicrotask(() => {
        (callback as (error: Error) => void)(failure);
        child.stdin.emit('error', failure);
      });
      return false;
    });
    await expect(runner.writeStdin(handle, 'pending ACP frame')).rejects.toBe(failure);
    await runner.stop(handle);
    const errors = [];
    for await (const event of runner.events(handle))
      if (event.type === 'process.error') errors.push(event.message);
    expect(errors).toContain('closed stdin pipe');
  } finally {
    await runner.stop(handle);
  }
});
