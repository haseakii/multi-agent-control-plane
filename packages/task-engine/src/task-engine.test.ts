import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { TaskEngine, TaskEngineError } from './index.js';

const tempDirectories: string[] = [];
let sequence = 0;
const now = '2026-10-19T07:10:00Z';

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-task-engine-'));
  tempDirectories.push(directory);
  return join(directory, 'task-engine.sqlite');
}

function createEngine(filename: string) {
  const storage = openSqliteStorage({ filename });
  const engine = new TaskEngine(storage.repositories, {
    now: () => now,
    idFactory: (kind) => `${kind}-test-${++sequence}`,
  });
  return { storage, engine };
}

function seedProject(storage: ReturnType<typeof openSqliteStorage>) {
  storage.repositories.projects.upsert({
    id: 'project-task-engine',
    name: 'Task Engine Test',
    createdAt: now,
    updatedAt: now,
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('TaskEngine', () => {
  it('enforces deterministic task transitions and dependency completion', () => {
    const { storage, engine } = createEngine(createDatabasePath());
    seedProject(storage);

    const prerequisite = engine.createTask({
      id: 'task-prerequisite',
      projectId: 'project-task-engine',
      title: 'Prerequisite',
      objective: 'Finish first',
      state: 'ready',
    });
    engine.transitionTask(prerequisite.id, 'running');
    engine.completeTask(prerequisite.id);

    const dependent = engine.createTask({
      id: 'task-dependent',
      projectId: 'project-task-engine',
      title: 'Dependent',
      objective: 'Run after prerequisite',
      dependencyIds: [prerequisite.id],
    });
    expect(engine.transitionTask(dependent.id, 'ready').state).toBe('ready');
    expect(engine.listReady('project-task-engine').map((task) => task.id)).toEqual([
      'task-dependent',
    ]);

    expect(() => engine.transitionTask(prerequisite.id, 'running')).toThrow(TaskEngineError);
    storage.close();
  });

  it('preserves failed attempts and replaced conversations across restart and explicit retry', () => {
    const filename = createDatabasePath();
    const first = createEngine(filename);
    seedProject(first.storage);

    const task = first.engine.createTask({
      id: 'task-retry',
      projectId: 'project-task-engine',
      title: 'Retry task',
      objective: 'Prove history survives',
      state: 'ready',
    });
    const assignment = first.engine.createAssignment({
      id: 'assignment-retry',
      taskId: task.id,
      agentId: 'agent-worker',
      role: { name: 'worker' },
      objective: task.objective,
    });

    const attempt1 = first.engine.createAttempt(assignment.id, {
      id: 'attempt-retry-1',
      runnerId: 'runner-local',
    });
    first.engine.startAttempt(attempt1.id);
    first.engine.attachConversation({
      id: 'conversation-retry-1',
      executionAttemptId: attempt1.id,
      runnerId: 'runner-local',
      protocol: 'acp-v1',
      sessionId: 'session-failed',
    });
    first.engine.attachConversation({
      id: 'conversation-retry-2',
      executionAttemptId: attempt1.id,
      runnerId: 'runner-local',
      protocol: 'acp-v1',
      sessionId: 'session-replacement',
    });
    first.engine.finishAttempt(attempt1.id, {
      outcome: 'failed',
      failure: {
        code: 'AGENT_SESSION_FAILED',
        message: 'Original agent conversation failed.',
        retryable: true,
      },
    });

    const attempt2 = first.engine.retryAssignment(assignment.id, {
      id: 'attempt-retry-2',
      runnerId: 'runner-local',
    });
    first.engine.startAttempt(attempt2.id);
    first.storage.close();

    const second = createEngine(filename);
    expect(second.engine.getTask(task.id).state).toBe('running');
    expect(second.engine.listAttempts(assignment.id).map((attempt) => attempt.state)).toEqual([
      'failed',
      'running',
    ]);
    expect(second.engine.listConversations(attempt1.id).map((item) => item.sessionId)).toEqual([
      'session-failed',
      'session-replacement',
    ]);

    const interrupted = second.engine.recoverInterruptedAttempts();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.state).toBe('interrupted');
    expect(second.engine.getTask(task.id).state).toBe('waiting');

    const attempt3 = second.engine.retryAssignment(assignment.id, {
      id: 'attempt-retry-3',
      runnerId: 'runner-local',
    });
    expect(attempt3.number).toBe(3);
    expect(second.engine.listAttempts(assignment.id)).toHaveLength(3);
    second.storage.close();
  });

  it('cascades cancellation to child tasks, assignments, and queued attempts', () => {
    const { storage, engine } = createEngine(createDatabasePath());
    seedProject(storage);

    const parent = engine.createTask({
      id: 'task-parent',
      projectId: 'project-task-engine',
      title: 'Parent',
      objective: 'Coordinate child',
      state: 'ready',
    });
    const child = engine.createTask({
      id: 'task-child',
      projectId: 'project-task-engine',
      parentTaskId: parent.id,
      title: 'Child',
      objective: 'Do child work',
      state: 'ready',
    });
    const assignment = engine.createAssignment({
      id: 'assignment-child',
      taskId: child.id,
      agentId: 'agent-child',
      objective: child.objective,
    });
    const attempt = engine.createAttempt(assignment.id, { id: 'attempt-child' });

    engine.cancelTask(parent.id);

    expect(engine.getTask(parent.id).state).toBe('cancelled');
    expect(engine.getTask(child.id).state).toBe('cancelled');
    expect(storage.repositories.assignments.get(assignment.id)?.state).toBe('cancelled');
    expect(storage.repositories.executionAttempts.get(attempt.id)?.state).toBe('cancelled');
    storage.close();
  });
});
