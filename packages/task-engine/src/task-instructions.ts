import { createHash } from 'node:crypto';
import {
  AuditEventSchema,
  SubmitTaskInstructionSchema,
  TaskInstructionSchema,
  type AuditEvent,
  type ExecutionAttemptId,
  type Task,
  type TaskInstruction,
} from '@control-plane/core';

export interface TaskInstructionStore {
  transaction<T>(operation: () => T): T;
  get(id: string): TaskInstruction | undefined;
  listByTask(taskId: string): TaskInstruction[];
  save(instruction: TaskInstruction): TaskInstruction;
  audit(event: AuditEvent): void;
}
export class TaskInstructionError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'LIMIT' | 'INTEGRITY' | 'STALE',
    message: string,
  ) {
    super(message);
    this.name = 'TaskInstructionError';
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class TaskInstructionQueue {
  constructor(
    private readonly store: TaskInstructionStore,
    private readonly now: () => string,
  ) {}
  list(task: Task): TaskInstruction[] {
    const rows = this.readSaved(() => this.store.listByTask(task.id));
    for (const row of rows) {
      if (
        row.projectId !== task.projectId ||
        row.taskId !== task.id ||
        row.id !== 'instruction-' + digest([task.projectId, task.id, row.idempotencyKeyHash])
      )
        throw new TaskInstructionError('INTEGRITY', 'Saved task instruction is unavailable.');
    }
    return rows;
  }
  submit(
    task: Task,
    raw: unknown,
    allowNew: () => void,
    actor: TaskInstruction['actor'] = { type: 'user', id: 'local-operator' },
  ): { instruction: TaskInstruction; reused: boolean } {
    const input = SubmitTaskInstructionSchema.parse(raw);
    const keyHash = digest(input.idempotencyKey),
      id = 'instruction-' + digest([task.projectId, task.id, keyHash]);
    return this.store.transaction(() => {
      const existing = this.readSaved(() => this.store.get(id));
      if (existing) {
        if (
          existing.projectId !== task.projectId ||
          existing.taskId !== task.id ||
          existing.content !== input.content ||
          existing.idempotencyKeyHash !== keyHash
        )
          throw new TaskInstructionError(
            'CONFLICT',
            'Idempotency key was already used for different task input.',
          );
        return { instruction: existing, reused: true };
      }
      allowNew();
      const previous = this.list(task);
      if (
        previous.length >= 32 ||
        previous.reduce((total, row) => total + Buffer.byteLength(row.content), 0) +
          Buffer.byteLength(input.content) >
          32000
      )
        throw new TaskInstructionError(
          'LIMIT',
          'This task reached the V0 instruction history limit; summarize the remaining work as a new goal.',
        );
      const at = this.now();
      const instruction = this.store.save(
        TaskInstructionSchema.parse({
          formatVersion: 1,
          id,
          projectId: task.projectId,
          taskId: task.id,
          actor,
          content: input.content,
          idempotencyKeyHash: keyHash,
          state: 'queued',
          createdAt: at,
          updatedAt: at,
        }),
      );
      this.audit('queued', instruction);
      return { instruction, reused: false };
    });
  }
  pending(task: Task, attemptId: ExecutionAttemptId): TaskInstruction[] {
    return this.list(task).filter(
      (row) =>
        row.state === 'queued' || (row.state === 'claimed' && row.ownerAttemptId !== attemptId),
    );
  }
  claim(task: Task, attemptId: ExecutionAttemptId, assertOwner: () => void): TaskInstruction[] {
    return this.store.transaction(() => {
      assertOwner();
      return this.pending(task, attemptId).map((row) => {
        const instruction = this.store.save(
          TaskInstructionSchema.parse({
            ...row,
            state: 'claimed',
            ownerAttemptId: attemptId,
            updatedAt: this.now(),
          }),
        );
        this.audit('claimed', instruction, attemptId);
        return instruction;
      });
    });
  }
  acknowledge(
    task: Task,
    attemptId: ExecutionAttemptId,
    ids: string[],
    assertOwner: () => void,
  ): void {
    this.store.transaction(() => {
      assertOwner();
      for (const id of ids) {
        const row = this.readSaved(() => this.store.get(id));
        if (
          !row ||
          row.taskId !== task.id ||
          row.projectId !== task.projectId ||
          row.ownerAttemptId !== attemptId ||
          row.state === 'queued'
        )
          throw new TaskInstructionError(
            'STALE',
            'Task instruction is no longer owned by this attempt.',
          );
        if (row.state === 'delivered') continue;
        const at = this.now();
        const instruction = this.store.save(
          TaskInstructionSchema.parse({
            ...row,
            state: 'delivered',
            deliveredAt: at,
            updatedAt: at,
          }),
        );
        this.audit('delivered', instruction, attemptId);
      }
    });
  }
  private readSaved<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw new TaskInstructionError('INTEGRITY', 'Saved task instruction is unavailable.');
    }
  }
  private audit(
    stage: 'queued' | 'claimed' | 'delivered',
    instruction: TaskInstruction,
    attemptId?: ExecutionAttemptId,
  ): void {
    this.store.audit(
      AuditEventSchema.parse({
        id: 'instruction-event-' + digest([instruction.id, stage, attemptId ?? null]),
        projectId: instruction.projectId,
        taskId: instruction.taskId,
        type: 'task.instruction.' + stage,
        actor:
          stage === 'queued' ? instruction.actor : { type: 'system', id: 'task-instruction-queue' },
        payload: { instructionId: instruction.id, ...(attemptId ? { attemptId } : {}) },
        occurredAt: instruction.updatedAt,
      }),
    );
  }
}
