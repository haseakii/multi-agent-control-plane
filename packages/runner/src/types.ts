import type { Runner as RunnerDescriptor, RunnerId } from '@control-plane/core';

export type ProcessState =
  | 'running'
  | 'stopping'
  | 'exited'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type ProcessSpec = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ProcessHandle = {
  id: string;
  runnerId: RunnerId;
  pid: number;
  startedAt: string;
};

export type ProcessStatus = ProcessHandle & {
  state: ProcessState;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

type RunnerEventBase = {
  sequence: number;
  occurredAt: string;
  runnerId: RunnerId;
  handleId: string;
};

export type RunnerEvent =
  | (RunnerEventBase & { type: 'process.started'; pid: number })
  | (RunnerEventBase & { type: 'process.stdout'; chunk: string })
  | (RunnerEventBase & { type: 'process.stderr'; chunk: string })
  | (RunnerEventBase & { type: 'process.stop_requested'; reason: 'requested' | 'cancelled' })
  | (RunnerEventBase & { type: 'process.timeout'; timeoutMs: number })
  | (RunnerEventBase & { type: 'process.error'; message: string })
  | (RunnerEventBase & {
      type: 'process.exited';
      state: Extract<ProcessState, 'exited' | 'failed' | 'timed_out' | 'cancelled'>;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    });

export type StopOptions = {
  gracePeriodMs?: number;
};

export interface Runner {
  descriptor(): RunnerDescriptor;
  spawn(spec: ProcessSpec): Promise<ProcessHandle>;
  stop(handle: ProcessHandle, options?: StopOptions): Promise<ProcessStatus>;
  status(handle: ProcessHandle): ProcessStatus;
  wait(handle: ProcessHandle): Promise<ProcessStatus>;
  events(handle: ProcessHandle, options?: { replay?: boolean }): AsyncIterable<RunnerEvent>;
  writeStdin(handle: ProcessHandle, chunk: string | Uint8Array): Promise<void>;
  endStdin(handle: ProcessHandle): void;
}
