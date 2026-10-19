import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  RunnerIdSchema,
  RunnerSchema,
  type Runner as RunnerDescriptor,
  type RunnerId,
} from '@control-plane/core';
import { EventChannel } from './event-channel.js';
import type {
  ProcessHandle,
  ProcessSpec,
  ProcessState,
  ProcessStatus,
  Runner,
  RunnerEvent,
  StopOptions,
} from './types.js';

type TerminationReason = 'requested' | 'cancelled' | 'timeout';

type ProcessRecord = {
  handle: ProcessHandle;
  child: ChildProcessWithoutNullStreams;
  state: ProcessState;
  channel: EventChannel<RunnerEvent>;
  exitPromise: Promise<ProcessStatus>;
  resolveExit: (status: ProcessStatus) => void;
  sequence: number;
  terminationReason?: TerminationReason;
  timeout?: NodeJS.Timeout;
  abortCleanup?: () => void;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  exitedAt?: string;
  finalized: boolean;
};

export type LocalRunnerOptions = {
  id?: string;
  labels?: string[];
  capabilities?: string[];
  inheritedEnvironmentKeys?: string[];
  maxEnvironmentEntries?: number;
  maxEnvironmentValueBytes?: number;
  maxArguments?: number;
  maxArgumentBytes?: number;
  eventHistoryLimit?: number;
  outputChunkCharacters?: number;
  defaultStopGracePeriodMs?: number;
};

const defaultEnvironmentKeys =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP'];

export class LocalRunner implements Runner {
  private readonly runnerId: RunnerId;
  private readonly records = new Map<string, ProcessRecord>();
  private readonly labels: string[];
  private readonly capabilities: string[];
  private readonly inheritedEnvironmentKeys: string[];
  private readonly maxEnvironmentEntries: number;
  private readonly maxEnvironmentValueBytes: number;
  private readonly maxArguments: number;
  private readonly maxArgumentBytes: number;
  private readonly eventHistoryLimit: number;
  private readonly outputChunkCharacters: number;
  private readonly defaultStopGracePeriodMs: number;

  constructor(options: LocalRunnerOptions = {}) {
    this.runnerId = RunnerIdSchema.parse(options.id ?? 'local');
    this.labels = [...(options.labels ?? [process.platform, process.arch])];
    this.capabilities = [
      ...(options.capabilities ?? [
        'process.spawn',
        'process.stop',
        'process.status',
        'process.stdin',
        'process.output',
        'process.timeout',
        'process.abort',
      ]),
    ];
    this.inheritedEnvironmentKeys = [
      ...(options.inheritedEnvironmentKeys ?? defaultEnvironmentKeys),
    ];
    this.maxEnvironmentEntries = options.maxEnvironmentEntries ?? 64;
    this.maxEnvironmentValueBytes = options.maxEnvironmentValueBytes ?? 16 * 1024;
    this.maxArguments = options.maxArguments ?? 256;
    this.maxArgumentBytes = options.maxArgumentBytes ?? 16 * 1024;
    this.eventHistoryLimit = options.eventHistoryLimit ?? 512;
    this.outputChunkCharacters = options.outputChunkCharacters ?? 64 * 1024;
    this.defaultStopGracePeriodMs = options.defaultStopGracePeriodMs ?? 2_000;
  }

  descriptor(): RunnerDescriptor {
    return RunnerSchema.parse({
      id: this.runnerId,
      kind: 'local',
      labels: [...this.labels],
      capabilities: [...this.capabilities],
      status: 'ready',
    });
  }

  async spawn(spec: ProcessSpec): Promise<ProcessHandle> {
    const normalized = this.normalizeSpec(spec);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const child = spawn(normalized.command, normalized.args, {
      cwd: normalized.cwd,
      env: normalized.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    if (child.pid === undefined) {
      throw new Error('Spawned process did not expose a pid.');
    }

    const handle: ProcessHandle = {
      id,
      runnerId: this.runnerId,
      pid: child.pid,
      startedAt,
    };

    let resolveExit!: (status: ProcessStatus) => void;
    const exitPromise = new Promise<ProcessStatus>((resolveExitPromise) => {
      resolveExit = resolveExitPromise;
    });

    const record: ProcessRecord = {
      handle,
      child,
      state: 'running',
      channel: new EventChannel(this.eventHistoryLimit),
      exitPromise,
      resolveExit,
      sequence: 0,
      finalized: false,
    };
    this.records.set(id, record);

    this.attachOutput(record, child.stdout, 'process.stdout');
    this.attachOutput(record, child.stderr, 'process.stderr');

    child.once('error', (error) => {
      this.publish(record, {
        type: 'process.error',
        message: error.message,
      });
    });

    child.once('close', (exitCode, signal) => {
      this.finalize(record, exitCode, signal);
    });

    this.publish(record, {
      type: 'process.started',
      pid: child.pid,
    });

    if (normalized.timeoutMs !== undefined) {
      record.timeout = setTimeout(() => {
        if (record.finalized) {
          return;
        }
        record.terminationReason = 'timeout';
        this.publish(record, {
          type: 'process.timeout',
          timeoutMs: normalized.timeoutMs!,
        });
        void this.stopRecord(record, normalized.stopGracePeriodMs);
      }, normalized.timeoutMs);
      record.timeout.unref();
    }

    if (spec.signal) {
      const onAbort = () => {
        if (record.finalized) {
          return;
        }
        record.terminationReason = 'cancelled';
        this.publish(record, {
          type: 'process.stop_requested',
          reason: 'cancelled',
        });
        void this.stopRecord(record, normalized.stopGracePeriodMs);
      };
      spec.signal.addEventListener('abort', onAbort, { once: true });
      record.abortCleanup = () => spec.signal?.removeEventListener('abort', onAbort);
      if (spec.signal.aborted) {
        onAbort();
      }
    }

    return structuredClone(handle);
  }

  status(handle: ProcessHandle): ProcessStatus {
    const record = this.getRecord(handle);
    return this.snapshot(record);
  }

  wait(handle: ProcessHandle): Promise<ProcessStatus> {
    return this.getRecord(handle).exitPromise;
  }

  events(handle: ProcessHandle, options: { replay?: boolean } = {}): AsyncIterable<RunnerEvent> {
    const record = this.getRecord(handle);
    return record.channel.subscribe(options.replay ?? true);
  }

  async stop(handle: ProcessHandle, options: StopOptions = {}): Promise<ProcessStatus> {
    const record = this.getRecord(handle);
    if (record.finalized) {
      return this.snapshot(record);
    }

    if (record.terminationReason === undefined) {
      record.terminationReason = 'requested';
      this.publish(record, {
        type: 'process.stop_requested',
        reason: 'requested',
      });
    }

    return this.stopRecord(record, options.gracePeriodMs ?? this.defaultStopGracePeriodMs);
  }

  async writeStdin(handle: ProcessHandle, chunk: string | Uint8Array): Promise<void> {
    const record = this.getRecord(handle);
    if (record.finalized || record.child.stdin.destroyed || record.child.stdin.writableEnded) {
      throw new Error(`Process ${handle.id} stdin is not writable.`);
    }

    await new Promise<void>((resolveWrite, rejectWrite) => {
      const bytes = typeof chunk === 'string' ? chunk : Buffer.from(chunk);
      const callback = (error?: Error | null) => {
        if (error) {
          rejectWrite(error);
        } else {
          resolveWrite();
        }
      };
      record.child.stdin.write(bytes, callback);
    });
  }

  endStdin(handle: ProcessHandle): void {
    const record = this.getRecord(handle);
    if (!record.child.stdin.destroyed && !record.child.stdin.writableEnded) {
      record.child.stdin.end();
    }
  }

  private normalizeSpec(spec: ProcessSpec): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stopGracePeriodMs: number;
  } {
    if (spec.command.trim().length === 0) {
      throw new TypeError('Process command must not be empty.');
    }

    const args = [...(spec.args ?? [])];
    if (args.length > this.maxArguments) {
      throw new RangeError(`Process argument count exceeds ${this.maxArguments}.`);
    }
    for (const argument of args) {
      if (Buffer.byteLength(argument) > this.maxArgumentBytes) {
        throw new RangeError(`Process argument exceeds ${this.maxArgumentBytes} bytes.`);
      }
    }

    const cwd = resolve(spec.cwd ?? process.cwd());
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) {
      throw new TypeError(`Process cwd is not a directory: ${cwd}`);
    }

    const env: NodeJS.ProcessEnv = {};
    for (const key of this.inheritedEnvironmentKeys) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new TypeError(`Invalid environment key: ${key}`);
      }
      if (Buffer.byteLength(value) > this.maxEnvironmentValueBytes) {
        throw new RangeError(
          `Environment value for ${key} exceeds ${this.maxEnvironmentValueBytes} bytes.`,
        );
      }
      env[key] = value;
    }
    if (Object.keys(env).length > this.maxEnvironmentEntries) {
      throw new RangeError(`Environment entry count exceeds ${this.maxEnvironmentEntries}.`);
    }

    if (
      spec.timeoutMs !== undefined &&
      (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
    ) {
      throw new RangeError('timeoutMs must be a positive safe integer.');
    }

    return {
      command: spec.command,
      args,
      cwd,
      env,
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      stopGracePeriodMs: this.defaultStopGracePeriodMs,
    };
  }

  private attachOutput(
    record: ProcessRecord,
    stream: NodeJS.ReadableStream,
    type: 'process.stdout' | 'process.stderr',
  ): void {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer | string) => {
      this.publishOutput(record, type, decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    });
    stream.once('end', () => {
      this.publishOutput(record, type, decoder.end());
    });
  }

  private publishOutput(
    record: ProcessRecord,
    type: 'process.stdout' | 'process.stderr',
    value: string,
  ): void {
    for (let offset = 0; offset < value.length; offset += this.outputChunkCharacters) {
      const chunk = value.slice(offset, offset + this.outputChunkCharacters);
      if (chunk.length > 0) {
        this.publish(record, { type, chunk });
      }
    }
  }

  private async stopRecord(record: ProcessRecord, gracePeriodMs: number): Promise<ProcessStatus> {
    if (record.finalized) {
      return this.snapshot(record);
    }

    record.state = 'stopping';
    this.terminate(record, false);

    if (gracePeriodMs > 0) {
      const result = await Promise.race([
        record.exitPromise.then(() => 'exited' as const),
        new Promise<'timeout'>((resolveTimeout) => {
          const timeout = setTimeout(() => resolveTimeout('timeout'), gracePeriodMs);
          timeout.unref();
        }),
      ]);
      if (result === 'exited') {
        return this.snapshot(record);
      }
    }

    this.terminate(record, true);
    return record.exitPromise;
  }

  private terminate(record: ProcessRecord, force: boolean): void {
    if (record.finalized) {
      return;
    }

    if (process.platform === 'win32') {
      if (force) {
        const killer = spawn(
          'taskkill',
          ['/PID', String(record.handle.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true, shell: false },
        );
        killer.unref();
      } else {
        record.child.kill();
      }
      return;
    }

    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-record.handle.pid, signal);
    } catch {
      record.child.kill(signal);
    }
  }

  private finalize(
    record: ProcessRecord,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (record.finalized) {
      return;
    }

    record.finalized = true;
    if (record.timeout) {
      clearTimeout(record.timeout);
    }
    record.abortCleanup?.();
    record.exitCode = exitCode;
    record.exitSignal = signal;
    record.exitedAt = new Date().toISOString();

    const state: Extract<ProcessState, 'exited' | 'failed' | 'timed_out' | 'cancelled'> =
      record.terminationReason === 'timeout'
        ? 'timed_out'
        : record.terminationReason === 'cancelled'
          ? 'cancelled'
          : exitCode === 0 || record.terminationReason === 'requested'
            ? 'exited'
            : 'failed';
    record.state = state;

    this.publish(record, {
      type: 'process.exited',
      state,
      exitCode,
      signal,
    });
    record.channel.close();
    record.resolveExit(this.snapshot(record));
  }

  private snapshot(record: ProcessRecord): ProcessStatus {
    return {
      ...record.handle,
      state: record.state,
      ...(record.exitedAt === undefined ? {} : { exitedAt: record.exitedAt }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.exitSignal === undefined ? {} : { signal: record.exitSignal }),
    };
  }

  private publish(
    record: ProcessRecord,
    event:
      | Omit<Extract<RunnerEvent, { type: 'process.started' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>
      | Omit<Extract<RunnerEvent, { type: 'process.stdout' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>
      | Omit<Extract<RunnerEvent, { type: 'process.stderr' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>
      | Omit<Extract<RunnerEvent, { type: 'process.stop_requested' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>
      | Omit<Extract<RunnerEvent, { type: 'process.timeout' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>
      | Omit<Extract<RunnerEvent, { type: 'process.error' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>
      | Omit<Extract<RunnerEvent, { type: 'process.exited' }>, 'sequence' | 'occurredAt' | 'runnerId' | 'handleId'>,
  ): void {
    record.sequence += 1;
    record.channel.publish({
      ...event,
      sequence: record.sequence,
      occurredAt: new Date().toISOString(),
      runnerId: this.runnerId,
      handleId: record.handle.id,
    } as RunnerEvent);
  }

  private getRecord(handle: ProcessHandle): ProcessRecord {
    if (handle.runnerId !== this.runnerId) {
      throw new Error(
        `Process handle belongs to runner ${handle.runnerId}, not ${this.runnerId}.`,
      );
    }
    const record = this.records.get(handle.id);
    if (!record || record.handle.pid !== handle.pid) {
      throw new Error(`Unknown process handle: ${handle.id}`);
    }
    return record;
  }
}
