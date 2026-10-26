import { expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { ApprovalViewSchema, AuditEventSchema, TaskSchema } from '@control-plane/core';
import { conversationSnapshot } from './conversation-snapshot.js';
import type { ControlCenterSnapshot } from './control-center.js';
import { readControlCenterSnapshot } from './control-center.js';
import { buildServer } from './server.js';

const now = '2026-10-24T00:00:00.000Z';
function task(id: string, parentTaskId?: string) {
  return TaskSchema.parse({
    id,
    projectId: 'project',
    parentTaskId,
    title: id,
    objective: id,
    state: 'completed',
    dependencyIds: [],
    contextRefs: [],
    resultArtifactRefs: [],
    createdAt: now,
    updatedAt: now,
  });
}
function event(id: string, taskId: string, type = 'agent.progress', payload = {}) {
  return AuditEventSchema.parse({
    id,
    projectId: 'project',
    taskId,
    type,
    payload,
    actor: { type: 'system', id: 'test' },
    occurredAt: now,
  });
}
function snapshot(): ControlCenterSnapshot {
  return {
    generatedAt: now,
    projects: [],
    agents: [],
    assignments: [],
    artifacts: [],
    messages: [],
    runners: [],
    workspaces: [],
    tasks: [
      task('first'),
      task('worker', 'first'),
      task('nested', 'worker'),
      task('followup'),
      task('followup-worker', 'followup'),
      task('other'),
      task('other-followup'),
    ],
    approvals: [
      ApprovalViewSchema.parse({
        id: 'approval',
        projectId: 'project',
        taskId: 'other',
        action: 'acp.tool',
        resource: {},
        enforcementMode: 'cooperative',
        state: 'pending',
        requestedAt: now,
        decisionEligibility: {
          canApprove: false,
          canReject: false,
          reason: 'runtime_unavailable',
          checkedAt: now,
          validForMs: 0,
        },
      }),
    ],
    timeline: [
      event('link', 'followup', 'task.followup.created', {
        sourceTaskId: 'first',
        conversationRootTaskId: 'first',
      }),
      event('other-link', 'other-followup', 'task.followup.created', {
        sourceTaskId: 'other',
        conversationRootTaskId: 'other',
      }),
      ...[
        'first',
        'worker',
        'nested',
        'followup',
        'followup-worker',
        'other',
        'other-followup',
      ].map((id) => event(`progress-${id}`, id)),
    ],
  };
}

it('loads every round and nested collaborator of the selected conversation while retaining the sidebar index', () => {
  const source = snapshot();
  const expected = [
    'link',
    'other-link',
    'progress-first',
    'progress-worker',
    'progress-nested',
    'progress-followup',
    'progress-followup-worker',
  ];
  for (const selected of ['first', 'followup', 'nested', 'followup-worker']) {
    const result = conversationSnapshot(source, selected);
    expect(result.timeline.map((e) => e.id)).toEqual(expected);
    expect(result.timelineScope).toBe(selected);
    expect(result.tasks).toBe(source.tasks);
    expect(result.approvals).toBe(source.approvals);
    expect(result.artifacts).toBe(source.artifacts);
  }
  expect(source.timeline).toHaveLength(9);
});

it('loads only the conversation index on the home page and preserves another conversation when selected', () => {
  const source = snapshot();
  expect(conversationSnapshot(source).timeline.map((e) => e.id)).toEqual(['link', 'other-link']);
  expect(conversationSnapshot(source, 'missing').timeline.map((e) => e.id)).toEqual([
    'link',
    'other-link',
  ]);
  expect(conversationSnapshot(source, 'other').timeline.map((e) => e.id)).toEqual([
    'link',
    'other-link',
    'progress-other',
    'progress-other-followup',
  ]);
});

it('keeps the full API unchanged and refreshes approval eligibility on every projected read', async () => {
  const source = snapshot();
  const app = buildServer({ controlCenter: () => source });
  try {
    const full = (await app.inject({ url: '/api/control-center' })).json();
    expect(full.timeline).toHaveLength(9);
    expect(full).not.toHaveProperty('timelineScope');
    const home = (await app.inject({ url: '/api/control-center?view=conversation' })).json();
    expect(home.timeline).toHaveLength(2);
    expect(home.timelineScope).toBeNull();
    source.approvals[0]!.decisionEligibility = {
      canApprove: false,
      canReject: true,
      reason: 'deadline_expired',
      checkedAt: '2026-10-24T00:00:01.000Z',
      validForMs: 0,
    };
    const current = (
      await app.inject({ url: '/api/control-center?view=conversation&taskId=followup' })
    ).json();
    expect(current.timeline).toHaveLength(7);
    expect(current.approvals[0].decisionEligibility).toEqual(
      source.approvals[0]!.decisionEligibility,
    );
  } finally {
    await app.close();
  }
});

it('rejects invalid projection queries', async () => {
  const app = buildServer();
  try {
    for (const url of [
      '/api/control-center?view=unknown',
      '/api/control-center?view=conversation&taskId=',
    ])
      expect((await app.inject({ url })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

it('reads only indexed conversation events from storage and observes newly appended records', async () => {
  const storage = openSqliteStorage({ filename: ':memory:' });
  const source = snapshot();
  storage.repositories.projects.upsert({
    id: 'project',
    name: 'Project',
    createdAt: now,
    updatedAt: now,
  });
  for (const task of source.tasks) storage.repositories.tasks.upsert(task);
  for (const entry of source.timeline) storage.repositories.events.append(entry);
  for (let i = 0; i < 100; i++) storage.repositories.events.append(event(`extra-${i}`, 'other'));
  const calls = vi.spyOn(storage.repositories.events, 'listByProject');
  const app = buildServer({
    controlCenter: (options) =>
      readControlCenterSnapshot(storage, undefined, undefined, undefined, options),
  });
  try {
    const selected = (
      await app.inject({ url: '/api/control-center?view=conversation&taskId=followup' })
    ).json();
    expect(selected.timeline.map((e: { id: string }) => e.id)).toEqual([
      'link',
      'other-link',
      'progress-first',
      'progress-worker',
      'progress-nested',
      'progress-followup',
      'progress-followup-worker',
    ]);
    expect(calls.mock.calls.every((call) => call[1] !== undefined)).toBe(true);
    expect(calls.mock.results.flatMap((result) => result.value).length).toBe(9);
    storage.repositories.events.append(event('fresh-progress', 'followup'));
    const next = (
      await app.inject({ url: '/api/control-center?view=conversation&taskId=followup' })
    ).json();
    expect(next.timeline.at(-1).id).toBe('fresh-progress');
    const full = (await app.inject({ url: '/api/control-center' })).json();
    expect(full.timeline).toHaveLength(110);
  } finally {
    await app.close();
    storage.close();
  }
});
