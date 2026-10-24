import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { TaskEngine } from '@control-plane/task-engine';
import { taskAgentId } from '../../web/src/view-model.js';
import { readControlCenterSnapshot, seedDemoState } from './control-center.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('control-center durable demo', () => {
  it('preserves the multi-agent demo history across a storage restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'control-plane-demo-'));
    directories.push(directory);
    const filename = join(directory, 'control-plane.sqlite');

    const first = openSqliteStorage({ filename });
    seedDemoState(first);
    const before = readControlCenterSnapshot(first);
    first.close();

    const second = openSqliteStorage({ filename });
    const after = readControlCenterSnapshot(second);
    second.close();

    expect(before.projects).toHaveLength(1);
    expect(after.agents.map((agent) => agent.definition.id).sort()).toEqual([
      'demo-boss',
      'demo-worker',
    ]);
    expect(after.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);
    expect(after.messages).toHaveLength(2);
    expect(after.executionAttempts).toEqual(before.executionAttempts);
    expect(after.executionAttempts).toHaveLength(1);
    expect(after.artifacts.map((artifact) => artifact.id)).toEqual(['demo-artifact']);
    expect(after.timeline.map((event) => event.type)).toEqual([
      'boss.selected',
      'agents.discovered',
      'task.delegated',
      'worker.completed',
      'boss.completed',
    ]);
  });
});

it('projects the latest real assignment after queued restart recovery and redelegation completes', () => {
  const storage = openSqliteStorage({ filename: ':memory:' });
  try {
    const now = '2026-10-21T00:00:00Z';
    storage.repositories.projects.upsert({
      id: 'p',
      name: 'Contract',
      createdAt: now,
      updatedAt: now,
    });
    const engine = new TaskEngine(storage.repositories, { now: () => now });
    const task = engine.createTask({
      id: 't',
      projectId: 'p',
      title: 'Real task',
      objective: 'Real restart and redelegation',
      state: 'ready',
    });
    expect(task.ownerAgentId).toBeUndefined();
    expect(taskAgentId(task, readControlCenterSnapshot(storage))).toBeUndefined();
    const oldAssignment = engine.createAssignment({
      id: 'old',
      taskId: task.id,
      agentId: 'old-agent',
      objective: task.objective,
    });
    engine.createAttempt(oldAssignment.id, { id: 'old-attempt' });
    const restarted = new TaskEngine(storage.repositories, { now: () => now });
    expect(restarted.recoverInterruptedAttempts().map((attempt) => attempt.state)).toEqual([
      'interrupted',
    ]);
    expect(storage.repositories.assignments.get(oldAssignment.id)?.state).toBe('waiting');
    const current = restarted.createAssignment({
      id: 'new',
      taskId: task.id,
      agentId: 'new-agent',
      objective: task.objective,
    });
    const attempt = restarted.createAttempt(current.id, { id: 'new-attempt' });
    restarted.startAttempt(attempt.id);
    expect(taskAgentId(restarted.getTask(task.id), readControlCenterSnapshot(storage))).toBe(
      'new-agent',
    );
    restarted.finishAttempt(attempt.id, { outcome: 'completed' });
    restarted.completeTask(task.id);
    const snapshot = readControlCenterSnapshot(storage);
    expect(snapshot.tasks[0]?.state).toBe('completed');
    expect(snapshot.assignments.map((assignment) => assignment.state)).toEqual([
      'waiting',
      'completed',
    ]);
    expect(snapshot.executionAttempts?.map((attempt) => attempt.state)).toEqual([
      'interrupted',
      'completed',
    ]);
    expect(taskAgentId(snapshot.tasks[0]!, snapshot)).toBe('new-agent');
  } finally {
    storage.close();
  }
});

it('projects a real active attempt before a newer assignment with no execution', () => {
  const storage = openSqliteStorage({ filename: ':memory:' });
  try {
    const now = '2026-10-21T00:00:00Z';
    storage.repositories.projects.upsert({
      id: 'p',
      name: 'Contract',
      createdAt: now,
      updatedAt: now,
    });
    const engine = new TaskEngine(storage.repositories, { now: () => now });
    const task = engine.createTask({
      id: 't',
      projectId: 'p',
      title: 'Active execution',
      objective: 'Use the current execution',
      state: 'ready',
    });
    const current = engine.createAssignment({
      id: 'current',
      taskId: task.id,
      agentId: 'active-agent',
      objective: task.objective,
    });
    engine.createAttempt(current.id, { id: 'current-attempt' });
    engine.createAssignment({
      id: 'later',
      taskId: task.id,
      agentId: 'not-started-agent',
      objective: task.objective,
    });
    expect(taskAgentId(task, readControlCenterSnapshot(storage))).toBe('active-agent');
  } finally {
    storage.close();
  }
});
