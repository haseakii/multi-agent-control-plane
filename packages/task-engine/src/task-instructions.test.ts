import { describe, expect, it } from 'vitest';
import { TaskEngine } from './task-engine.js';
import { TaskInstructionQueue, TaskInstructionError } from './task-instructions.js';
import { openSqliteStorage, PotentialSecretError } from '@control-plane/storage';
import { TaskInstructionSchema, type ExecutionAttemptId } from '@control-plane/core';

const now = '2026-10-22T06:00:00Z';
function fixture() {
  const storage = openSqliteStorage({ filename: ':memory:' });
  const repo = storage.repositories;
  repo.projects.upsert({ id: 'p', name: 'test', createdAt: now, updatedAt: now });
  const engine = new TaskEngine(repo, { now: () => now });
  const task = engine.createTask({
    id: 't',
    projectId: 'p',
    title: 'test',
    objective: 'test',
    state: 'ready',
  });
  const assignment = engine.createAssignment({
    id: 'assign',
    taskId: task.id,
    agentId: 'a',
    objective: task.objective,
  });
  const first = engine.createAttempt(assignment.id, { id: 'attempt-1' });
  engine.recoverInterruptedAttempts();
  const second = engine.retryAssignment(assignment.id, { id: 'attempt-2' });
  const store = {
    transaction: repo.transaction,
    get: (id: string) => repo.taskInstructions.get(id),
    listByTask: (id: string) => repo.taskInstructions.list().filter((x) => x.taskId === id),
    save: repo.taskInstructions.upsert.bind(repo.taskInstructions),
    audit: repo.events.append.bind(repo.events),
  };
  const queue = new TaskInstructionQueue(store, () => now);
  const submit = (idempotencyKey = 'once', content = 'Keep the report concise') =>
    queue.submit(task, { content, idempotencyKey }, () => {});
  return { storage, repo, task, first, second, store, queue, submit };
}
describe('durable task instruction queue', () => {
  it('records local console provenance and keeps idempotent retries read-only after acceptance closes', () => {
    const f = fixture();
    try {
      const first = f.submit();
      expect(first.instruction).toMatchObject({
        state: 'queued',
        actor: { type: 'user', id: 'local-operator' },
      });
      expect(
        f.queue.submit(
          f.task,
          { content: first.instruction.content, idempotencyKey: 'once' },
          () => {
            throw Error('closed');
          },
        ),
      ).toEqual({ ...first, reused: true });
      expect(() => f.submit('once', 'Changed')).toThrow(TaskInstructionError);
      expect(
        f.repo.events.listByProject('p').filter((x) => x.type.startsWith('task.instruction.')),
      ).toHaveLength(1);
      expect(
        JSON.stringify(
          f.repo.events.listByProject('p').filter((x) => x.type.startsWith('task.instruction.')),
        ),
      ).not.toContain(first.instruction.content);
    } finally {
      f.storage.close();
    }
  });
  it('rejects client-supplied actor, empty content, excessive text and unbounded keys', () => {
    const f = fixture();
    try {
      for (const raw of [
        { content: 'x', idempotencyKey: 'k', actor: { type: 'agent', id: 'a' } },
        { content: ' ', idempotencyKey: 'k' },
        { content: 'x'.repeat(4001), idempotencyKey: 'k' },
        { content: 'x', idempotencyKey: 'k'.repeat(129) },
      ])
        expect(() => f.queue.submit(f.task, raw, () => {})).toThrow();
      expect(f.repo.taskInstructions.list()).toHaveLength(0);
    } finally {
      f.storage.close();
    }
  });
  it('rolls back a saved input when appending its audit event fails', () => {
    const f = fixture();
    try {
      const queue = new TaskInstructionQueue(
        {
          ...f.store,
          audit: () => {
            throw Error('unavailable');
          },
        },
        () => now,
      );
      expect(() =>
        queue.submit(f.task, { content: 'Input', idempotencyKey: 'k' }, () => {}),
      ).toThrow();
      expect(f.repo.taskInstructions.list()).toHaveLength(0);
    } finally {
      f.storage.close();
    }
  });
  it('reclaims only unacknowledged inputs for a new attempt and rejects stale acknowledgments', () => {
    const f = fixture();
    try {
      const input = f.submit().instruction;
      expect(f.queue.claim(f.task, f.first.id, () => {})[0]?.state).toBe('claimed');
      expect(f.queue.claim(f.task, f.first.id, () => {})).toEqual([]);
      expect(f.queue.claim(f.task, f.second.id, () => {})[0]?.ownerAttemptId).toBe(f.second.id);
      expect(() => f.queue.acknowledge(f.task, f.first.id, [input.id], () => {})).toThrow(
        TaskInstructionError,
      );
      f.queue.acknowledge(f.task, f.second.id, [input.id], () => {});
      f.queue.acknowledge(f.task, f.second.id, [input.id], () => {});
      expect(f.queue.pending(f.task, f.first.id)).toEqual([]);
      expect(f.queue.list(f.task)[0]?.state).toBe('delivered');
      expect(
        f.repo.events
          .listByProject('p')
          .filter((x) => x.type.startsWith('task.instruction.'))
          .filter((x) => x.type === 'task.instruction.delivered'),
      ).toHaveLength(1);
    } finally {
      f.storage.close();
    }
  });
  it('checks live ownership inside the atomic claim and acknowledgment boundary', () => {
    const f = fixture();
    try {
      const input = f.submit().instruction;
      expect(() =>
        f.queue.claim(f.task, f.first.id, () => {
          throw Error('stale');
        }),
      ).toThrow();
      expect(f.queue.list(f.task)[0]?.state).toBe('queued');
      f.queue.claim(f.task, f.first.id, () => {});
      expect(() =>
        f.queue.acknowledge(f.task, f.first.id, [input.id], () => {
          throw Error('stale');
        }),
      ).toThrow();
      expect(f.queue.list(f.task)[0]?.state).toBe('claimed');
    } finally {
      f.storage.close();
    }
  });
  it('bounds total UTF-8 history and row count without losing existing inputs', () => {
    const f = fixture();
    try {
      for (let i = 0; i < 32; i++) f.submit('k' + i, 'x');
      expect(() => f.submit('overflow')).toThrow(TaskInstructionError);
      expect(f.queue.list(f.task)).toHaveLength(32);
    } finally {
      f.storage.close();
    }
    const g = fixture();
    try {
      for (let i = 0; i < 2; i++) g.submit('k' + i, '汉'.repeat(4000));
      expect(() => g.submit('overflow', '汉'.repeat(4000))).toThrow(TaskInstructionError);
      expect(g.queue.list(g.task)).toHaveLength(2);
    } finally {
      g.storage.close();
    }
  });
  it('rejects synthetic credentials before both input and audit persistence', () => {
    const f = fixture();
    try {
      expect(() => f.submit('k', 'Use Bearer abcdefghijklmnopqrstuvwxyz0123456789')).toThrow(
        PotentialSecretError,
      );
      expect(f.repo.taskInstructions.list()).toHaveLength(0);
      expect(
        f.repo.events.listByProject('p').filter((x) => x.type.startsWith('task.instruction.')),
      ).toHaveLength(0);
    } finally {
      f.storage.close();
    }
  });
  it('fails closed on corrupt stored JSON without returning content or treating corruption as bad user input', () => {
    const f = fixture();
    try {
      const input = f.submit().instruction;
      f.storage.sqlite
        .prepare('UPDATE task_instructions SET payload=? WHERE id=?')
        .run('{"content":"private malformed stored text"}', input.id);
      expect(() => f.queue.list(f.task)).toThrow(TaskInstructionError);
      expect(() => f.submit()).toThrow(TaskInstructionError);
    } finally {
      f.storage.close();
    }
  });
  it('validates persisted state and delivery ownership invariants', () => {
    const f = fixture();
    try {
      const input = f.submit().instruction;
      expect(TaskInstructionSchema.safeParse({ ...input, state: 'claimed' }).success).toBe(false);
      expect(
        TaskInstructionSchema.safeParse({ ...input, ownerAttemptId: 'a' as ExecutionAttemptId })
          .success,
      ).toBe(false);
      expect(
        TaskInstructionSchema.safeParse({
          ...input,
          state: 'delivered',
          ownerAttemptId: f.first.id,
        }).success,
      ).toBe(false);
    } finally {
      f.storage.close();
    }
  });
});
