import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  RunnerIdSchema,
  AgentIdSchema,
  RunnerSchema,
  type Runner as RunnerDescriptor,
  type RunnerId,
} from '@control-plane/core';
import { EventChannel } from './event-channel.js';
import { redactPotentialSecrets } from './redact.js';
import { windowsWrapperIssue } from './windows-command.js';
import type {
  ProcessHandle,
  ProcessSpec,
  ProcessState,
  ProcessTransport,
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
  stdoutTransport: RawByteChannel;
};

type CompletedProcess = { status: ProcessStatus; channel: EventChannel<RunnerEvent> };

function outputBytes(event: RunnerEvent): number {
  return event.type === 'process.stdout' || event.type === 'process.stderr'
    ? Buffer.byteLength(event.chunk)
    : 0;
}

class RawByteChannel {
  private readonly queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private claimed = false;
  private closed = false;
  private consumerCancelled = false;
  private failure: Error | undefined;
  private overflowed = false;

  constructor(private readonly maxQueuedBytes = 1024 * 1024) {}

  push(chunk: Uint8Array): void {
    if (this.closed || this.failure) {
      return;
    }

    const copy = Uint8Array.from(chunk);
    if (this.controller) {
      this.controller.enqueue(copy);
      return;
    }

    if (this.overflowed || this.queuedBytes + copy.byteLength > this.maxQueuedBytes) {
      this.overflowed = true;
      this.queued.length = 0;
      this.queuedBytes = 0;
      return;
    }

    this.queued.push(copy);
    this.queuedBytes += copy.byteLength;
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }
    this.closed = true;
    if (!this.consumerCancelled) {
      this.controller?.close();
    }
    this.controller = undefined;
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    if (!this.consumerCancelled) {
      this.controller?.error(error);
    }
    this.controller = undefined;
  }

  claim(): ReadableStream<Uint8Array> {
    if (this.claimed) {
      throw new Error('Process stdout transport has already been claimed.');
    }
    this.claimed = true;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        if (this.overflowed) {
          controller.error(new Error('Process stdout exceeded the pre-claim transport buffer.'));
          return;
        }
        for (const chunk of this.queued.splice(0)) {
          controller.enqueue(chunk);
        }
        this.queuedBytes = 0;
        if (this.failure) {
          controller.error(this.failure);
          return;
        }
        if (this.closed) {
          controller.close();
          this.controller = undefined;
        }
      },
      cancel: () => {
        this.consumerCancelled = true;
        this.controller = undefined;
        this.queued.length = 0;
        this.queuedBytes = 0;
      },
    });
  }
}

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
  /** Completed handles remain readable only within this bounded in-memory cache. */
  completedProcessLimit?: number;
  completedOutputBytesLimit?: number;
};

const defaultEnvironmentKeys =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP'];

export class LocalRunner implements Runner {
  private readonly runnerId: RunnerId;
  private readonly records = new Map<string, ProcessRecord>();
  private readonly completed = new Map<string, CompletedProcess>();
  private completedOutputBytes = 0;
  private readonly completedProcessLimit: number;
  private readonly completedOutputBytesLimit: number;
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
    this.completedProcessLimit = options.completedProcessLimit ?? 64;
    this.completedOutputBytesLimit = options.completedOutputBytesLimit ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.completedProcessLimit) || this.completedProcessLimit < 1)
      throw new RangeError('completedProcessLimit must be a positive safe integer.');
    if (!Number.isSafeInteger(this.completedOutputBytesLimit) || this.completedOutputBytesLimit < 0)
      throw new RangeError('completedOutputBytesLimit must be a nonnegative safe integer.');
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

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolveSpawn();
      };
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        rejectSpawn(error);
      };

      child.once('spawn', onSpawn);
      child.once('error', onError);
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
      channel: new EventChannel(this.eventHistoryLimit, outputBytes),
      exitPromise,
      resolveExit,
      sequence: 0,
      finalized: false,
      stdoutTransport: new RawByteChannel(),
    };
    this.records.set(id, record);

    this.attachOutput(record, child.stdout, 'process.stdout');
    this.attachOutput(record, child.stderr, 'process.stderr');

    child.once('error', (error) => {
      record.stdoutTransport.fail(error);
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
    const completed = this.completedRecord(handle);
    if (completed) return structuredClone(completed.status);
    const record = this.getRecord(handle);
    return this.snapshot(record);
  }

  wait(handle: ProcessHandle): Promise<ProcessStatus> {
    const completed = this.completedRecord(handle);
    if (completed) return Promise.resolve(structuredClone(completed.status));
    return this.getRecord(handle).exitPromise;
  }

  events(handle: ProcessHandle, options: { replay?: boolean } = {}): AsyncIterable<RunnerEvent> {
    const record = this.completedRecord(handle) ?? this.getRecord(handle);
    return record.channel.subscribe(options.replay ?? true);
  }

  async stop(handle: ProcessHandle, options: StopOptions = {}): Promise<ProcessStatus> {
    const completed = this.completedRecord(handle);
    if (completed) return structuredClone(completed.status);
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

  transport(handle: ProcessHandle): ProcessTransport {
    const record = this.getRecord(handle);
    const readable = record.stdoutTransport.claim();
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.writeStdin(handle, chunk);
      },
      close: () => {
        this.endStdin(handle);
      },
      abort: async () => {
        await this.stop(handle);
      },
    });

    return { readable, writable };
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
    if (spec.agentId !== undefined) AgentIdSchema.parse(spec.agentId);
    if (spec.command.trim().length === 0) {
      throw new TypeError('Process command must not be empty.');
    }

    const wrapperIssue = windowsWrapperIssue(spec.command, process.platform);
    if (wrapperIssue) throw new TypeError(wrapperIssue);

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
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (type === 'process.stdout') {
        record.stdoutTransport.push(bytes);
      }
      this.publishOutput(record, type, decoder.write(bytes));
    });
    stream.once('end', () => {
      if (type === 'process.stdout') {
        record.stdoutTransport.close();
      }
      this.publishOutput(record, type, decoder.end());
    });
  }

  private publishOutput(
    record: ProcessRecord,
    type: 'process.stdout' | 'process.stderr',
    value: string,
  ): void {
    for (let offset = 0; offset < value.length; offset += this.outputChunkCharacters) {
      const chunk = redactPotentialSecrets(
        value.slice(offset, offset + this.outputChunkCharacters),
      );
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
      // Windows kill() ends the launcher before /T can discover its descendants.
      // Terminate the owned tree while the root PID still exists, including on first stop.
      const killer = spawn('taskkill', ['/PID', String(record.handle.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      killer.on('error', () => {
        this.publish(record, {
          type: 'process.error',
          message: 'Unable to terminate the owned Windows process tree.',
        });
      });
      killer.unref();
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
    const status = this.snapshot(record);
    // Never retain a ChildProcess, raw transport or its listener closures after
    // exit. Durable task/artifact history is owned by the control plane.
    this.records.delete(record.handle.id);
    this.completed.set(record.handle.id, {
      status: structuredClone(status),
      channel: record.channel,
    });
    this.completedOutputBytes += record.channel.retainedBytes;
    for (const [id, completed] of this.completed) {
      if (this.completed.size <= this.completedProcessLimit) break;
      this.completedOutputBytes -= completed.channel.retainedBytes;
      completed.channel.clearHistory();
      this.completed.delete(id);
    }
    for (const completed of this.completed.values()) {
      if (this.completedOutputBytes <= this.completedOutputBytesLimit) break;
      this.completedOutputBytes -= completed.channel.retainedBytes;
      completed.channel.clearHistory();
    }
    record.resolveExit(status);
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
      | Omit<
          Extract<RunnerEvent, { type: 'process.started' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >
      | Omit<
          Extract<RunnerEvent, { type: 'process.stdout' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >
      | Omit<
          Extract<RunnerEvent, { type: 'process.stderr' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >
      | Omit<
          Extract<RunnerEvent, { type: 'process.stop_requested' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >
      | Omit<
          Extract<RunnerEvent, { type: 'process.timeout' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >
      | Omit<
          Extract<RunnerEvent, { type: 'process.error' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >
      | Omit<
          Extract<RunnerEvent, { type: 'process.exited' }>,
          'sequence' | 'occurredAt' | 'runnerId' | 'handleId'
        >,
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
      throw new Error(`Process handle belongs to runner ${handle.runnerId}, not ${this.runnerId}.`);
    }
    const record = this.records.get(handle.id);
    if (!record || record.handle.pid !== handle.pid) {
      throw new Error(`Unknown process handle: ${handle.id}`);
    }
    return record;
  }

  private completedRecord(handle: ProcessHandle): CompletedProcess | undefined {
    if (handle.runnerId !== this.runnerId)
      throw new Error(`Process handle belongs to runner ${handle.runnerId}, not ${this.runnerId}.`);
    const completed = this.completed.get(handle.id);
    if (completed && completed.status.pid !== handle.pid)
      throw new Error(`Unknown process handle: ${handle.id}`);
    return completed;
  }
}
