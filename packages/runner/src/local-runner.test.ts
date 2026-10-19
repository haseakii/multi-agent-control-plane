import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRunner, type RunnerEvent } from './index.js';

const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-runner-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  delete process.env.RUNNER_SHOULD_NOT_LEAK;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function collectEvents(
  runner: LocalRunner,
  handle: Awaited<ReturnType<LocalRunner['spawn']>>,
): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const event of runner.events(handle)) {
    events.push(event);
  }
  return events;
}

describe('LocalRunner', () => {
  it('spawns a process and exposes normalized stdout/stderr/exit events with runner identity', async () => {
    const runner = new LocalRunner({ id: 'runner-local-test', labels: ['test'] });
    const handle = await runner.spawn({
      command: process.execPath,
      args: ['-e', "console.log('hello-out'); console.error('hello-err')"],
      cwd: tempDirectory(),
    });

    const eventsPromise = collectEvents(runner, handle);
    const status = await runner.wait(handle);
    const events = await eventsPromise;

    expect(handle.runnerId).toBe('runner-local-test');
    expect(status.runnerId).toBe('runner-local-test');
    expect(status.state).toBe('exited');
    expect(events.some((event) => event.type === 'process.started')).toBe(true);
    expect(
      events.some((event) => event.type === 'process.stdout' && event.chunk.includes('hello-out')),
    ).toBe(true);
    expect(
      events.some((event) => event.type === 'process.stderr' && event.chunk.includes('hello-err')),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe('process.exited');
    expect(runner.descriptor().capabilities).toContain('process.output');
  });

  it('uses a bounded environment instead of inheriting arbitrary parent secrets', async () => {
    process.env.RUNNER_SHOULD_NOT_LEAK = 'parent-secret';
    const runner = new LocalRunner({ id: 'runner-env-test' });
    const handle = await runner.spawn({
      command: process.execPath,
      args: [
        '-e',
        "console.log(JSON.stringify({visible:process.env.VISIBLE,leaked:process.env.RUNNER_SHOULD_NOT_LEAK}))",
      ],
      cwd: tempDirectory(),
      env: { VISIBLE: 'explicit' },
    });

    const eventsPromise = collectEvents(runner, handle);
    await runner.wait(handle);
    const events = await eventsPromise;
    const stdout = events
      .filter((event): event is Extract<RunnerEvent, { type: 'process.stdout' }> => event.type === 'process.stdout')
      .map((event) => event.chunk)
      .join('');

    expect(JSON.parse(stdout.trim())).toEqual({ visible: 'explicit' });
  });

  it('times out and terminates long-running processes', async () => {
    const runner = new LocalRunner({ id: 'runner-timeout-test', defaultStopGracePeriodMs: 50 });
    const handle = await runner.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: tempDirectory(),
      timeoutMs: 150,
    });

    const eventsPromise = collectEvents(runner, handle);
    const status = await runner.wait(handle);
    const events = await eventsPromise;

    expect(status.state).toBe('timed_out');
    expect(events.some((event) => event.type === 'process.timeout')).toBe(true);
  });

  it('honors AbortSignal cancellation and supports explicit stdin writes', async () => {
    const runner = new LocalRunner({ id: 'runner-cancel-test', defaultStopGracePeriodMs: 50 });
    const controller = new AbortController();
    const handle = await runner.spawn({
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { console.log(d.trim()); setInterval(() => {}, 1000); });",
      ],
      cwd: tempDirectory(),
      signal: controller.signal,
    });

    const eventsPromise = collectEvents(runner, handle);
    await runner.writeStdin(handle, 'ping\n');

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();

    const status = await runner.wait(handle);
    const events = await eventsPromise;
    expect(status.state).toBe('cancelled');
    expect(
      events.some((event) => event.type === 'process.stdout' && event.chunk.includes('ping')),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'process.stop_requested' && event.reason === 'cancelled',
      ),
    ).toBe(true);
  });
});
