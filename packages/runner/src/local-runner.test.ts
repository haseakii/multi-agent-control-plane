import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRunner, type ProcessHandle, type RunnerEvent } from './index.js';
import { RunnerIdSchema } from '@control-plane/core';

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
  it('releases exited process records and bounds completed handles and output without losing subscribed output', async () => {
    const runner = new LocalRunner({
      completedProcessLimit: 3,
      completedOutputBytesLimit: 100_000,
    });
    const handles: ProcessHandle[] = [];
    for (let index = 0; index < 8; index++) {
      const handle = await runner.spawn({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(60000))'],
        cwd: tempDirectory(),
      });
      handles.push(handle);
      const events = collectEvents(runner, handle);
      const reader = runner.transport(handle).readable.getReader();
      const drained = (async () => {
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return bytes;
          bytes += chunk.value.byteLength;
        }
      })();
      const exited = await runner.wait(handle);
      expect(exited.state).toBe('exited');
      exited.state = 'running';
      expect(runner.status(handle).state).toBe('exited');
      expect(await drained).toBe(60000);
      expect(
        (await events)
          .filter((event) => event.type === 'process.stdout')
          .reduce(
            (bytes, event) =>
              bytes + (event.type === 'process.stdout' ? Buffer.byteLength(event.chunk) : 0),
            0,
          ),
      ).toBe(60000);
      expect((await runner.stop(handle)).state).toBe('exited');
    }
    expect((runner as unknown as { records: Map<string, unknown> }).records.size).toBe(0);
    for (const handle of handles.slice(0, -3))
      expect(() => runner.status(handle)).toThrow('Unknown process handle');
    let retained = 0;
    for (const handle of handles.slice(-3)) {
      expect(runner.status(handle).state).toBe('exited');
      for await (const event of runner.events(handle))
        if (event.type === 'process.stdout') retained += Buffer.byteLength(event.chunk);
    }
    expect(retained).toBeLessThanOrEqual(100_000);
    const last = handles.at(-1)!;
    const status = runner.status(last);
    status.state = 'running';
    expect((await runner.wait(last)).state).toBe('exited');
    expect(() => runner.status({ ...last, pid: last.pid + 1 })).toThrow('Unknown process handle');
    expect(() => runner.status({ ...last, runnerId: RunnerIdSchema.parse('different') })).toThrow(
      'belongs to runner',
    );
  });

  it('keeps active processes while completed history is evicted, including a zero output budget', async () => {
    const runner = new LocalRunner({ completedProcessLimit: 1, completedOutputBytesLimit: 0 });
    const active = await runner.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: tempDirectory(),
    });
    try {
      for (let index = 0; index < 3; index++) {
        const finished = await runner.spawn({
          command: process.execPath,
          args: ['-e', 'console.log("finished")'],
          cwd: tempDirectory(),
        });
        await runner.wait(finished);
        expect(
          (await collectEvents(runner, finished)).some((event) => event.type === 'process.stdout'),
        ).toBe(false);
        expect(runner.status(active).state).toBe('running');
      }
    } finally {
      await runner.stop(active);
    }
    expect((await runner.wait(active)).state).toBe('exited');
  });

  it('rejects invalid completed retention bounds before launching anything', () => {
    for (const completedProcessLimit of [0, -1, 0.5, Infinity])
      expect(() => new LocalRunner({ completedProcessLimit })).toThrow('completedProcessLimit');
    for (const completedOutputBytesLimit of [-1, 0.5, Infinity])
      expect(() => new LocalRunner({ completedOutputBytesLimit })).toThrow(
        'completedOutputBytesLimit',
      );
  });
  it.runIf(process.platform === 'win32')(
    'stops a launcher with a child that inherits its output pipes',
    async () => {
      const runner = new LocalRunner({ id: 'launcher-stop' });
      const handle = await runner.spawn({
        command: process.execPath,
        args: [
          '-e',
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"console.log('child-ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit'],windowsHide:true});setInterval(()=>{},1000);`,
        ],
        cwd: tempDirectory(),
        timeoutMs: 10000,
      });
      try {
        for await (const event of runner.events(handle)) {
          if (event.type === 'process.stdout' && event.chunk.includes('child-ready')) break;
        }
        expect((await runner.stop(handle)).state).toBe('exited');
      } finally {
        await runner.stop(handle);
      }
    },
    15000,
  );

  it.runIf(process.platform === 'win32').each(['.cmd', '.bat', '.ps1'])(
    'rejects a Windows %s wrapper before spawning',
    async (extension) => {
      const runner = new LocalRunner();
      await expect(runner.spawn({ command: `C:/missing/adapter${extension}` })).rejects.toThrow(
        'Windows .cmd/.bat/.ps1 wrappers cannot run with shell:false',
      );
    },
  );

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

  it('rejects process startup failures without leaking an unhandled child-process error', async () => {
    const directory = tempDirectory();
    const runner = new LocalRunner({ id: 'runner-spawn-error-test' });

    await expect(
      runner.spawn({
        command: join(directory, 'definitely-missing-control-plane-executable'),
        cwd: directory,
      }),
    ).rejects.toThrow();
  });

  it('uses a bounded environment instead of inheriting arbitrary parent secrets', async () => {
    process.env.RUNNER_SHOULD_NOT_LEAK = 'parent-secret';
    const runner = new LocalRunner({ id: 'runner-env-test' });
    const handle = await runner.spawn({
      command: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({visible:process.env.VISIBLE,leaked:process.env.RUNNER_SHOULD_NOT_LEAK}))',
      ],
      cwd: tempDirectory(),
      env: { VISIBLE: 'explicit' },
    });

    const eventsPromise = collectEvents(runner, handle);
    await runner.wait(handle);
    const events = await eventsPromise;
    const stdout = events
      .filter(
        (event): event is Extract<RunnerEvent, { type: 'process.stdout' }> =>
          event.type === 'process.stdout',
      )
      .map((event) => event.chunk)
      .join('');

    expect(JSON.parse(stdout.trim())).toEqual({ visible: 'explicit' });
  });

  it('redacts likely credentials from normalized process output', async () => {
    const runner = new LocalRunner({ id: 'runner-redaction-test' });
    const handle = await runner.spawn({
      command: process.execPath,
      args: [
        '-e',
        "console.log('Bearer abcdefghijklmnopqrstuvwxyz0123456789'); console.error('sk-abcdefghijklmnopqrstuvwxyz1234567890')",
      ],
      cwd: tempDirectory(),
    });

    const eventsPromise = collectEvents(runner, handle);
    await runner.wait(handle);
    const events = await eventsPromise;
    const output = events
      .filter(
        (event): event is Extract<RunnerEvent, { type: 'process.stdout' | 'process.stderr' }> =>
          event.type === 'process.stdout' || event.type === 'process.stderr',
      )
      .map((event) => event.chunk)
      .join('');

    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(output).toContain('[REDACTED_SECRET]');
  });

  it('exposes a claimed raw stdout transport without applying log redaction', async () => {
    const runner = new LocalRunner({ id: 'runner-transport-test', defaultStopGracePeriodMs: 50 });
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const handle = await runner.spawn({
      command: process.execPath,
      args: ['-e', `console.log('${secret}'); setInterval(() => {}, 1000)`],
      cwd: tempDirectory(),
    });

    const eventsPromise = collectEvents(runner, handle);
    const transport = runner.transport(handle);
    const reader = transport.readable.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain(secret);
    expect(() => runner.transport(handle)).toThrow('already been claimed');

    await runner.stop(handle);
    const events = await eventsPromise;
    const normalized = events
      .filter(
        (event): event is Extract<RunnerEvent, { type: 'process.stdout' }> =>
          event.type === 'process.stdout',
      )
      .map((event) => event.chunk)
      .join('');
    expect(normalized).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(normalized).toContain('[REDACTED_SECRET]');
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

    const events: RunnerEvent[] = [];
    let resolvePing!: () => void;
    const pingSeen = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    const eventsPromise = (async () => {
      for await (const event of runner.events(handle)) {
        events.push(event);
        if (event.type === 'process.stdout' && event.chunk.includes('ping')) {
          resolvePing();
        }
      }
    })();

    await runner.writeStdin(handle, 'ping\n');
    await Promise.race([
      pingSeen,
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for stdin echo.')),
          2_000,
        );
        timeout.unref();
      }),
    ]);

    controller.abort();

    const status = await runner.wait(handle);
    await eventsPromise;
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
