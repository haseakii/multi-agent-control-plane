import { expect, it } from 'vitest';
import {
  recentMemberTask,
  memberProgramIdentity,
  memberExecutionLabel,
  type MemberActivityData,
} from '../src/member-history';
const activity: MemberActivityData = {
  tasks: [
    { id: 'root', title: 'Project work' },
    { id: 'child', title: 'Worker edits', parentTaskId: 'root' },
    { id: 'other', title: 'Other work' },
  ],
  assignments: [
    {
      id: 'a',
      agentId: 'worker',
      taskId: 'child',
      createdAt: '2026-10-24T01:00:00Z',
      state: 'completed',
    },
    {
      id: 'b',
      agentId: 'worker',
      taskId: 'other',
      createdAt: '2026-10-24T02:00:00Z',
      state: 'completed',
    },
    {
      id: 'c',
      agentId: 'another',
      taskId: 'root',
      createdAt: '2026-10-24T04:00:00Z',
      state: 'running',
    },
  ],
  executionAttempts: [
    { assignmentId: 'a', state: 'failed', createdAt: '2026-10-24T01:00:00Z' },
    { assignmentId: 'a', state: 'completed', createdAt: '2026-10-24T03:00:00Z' },
    { assignmentId: 'b', state: 'completed', createdAt: '2026-10-24T02:00:00Z' },
    { assignmentId: 'c', state: 'running', createdAt: '2026-10-24T04:00:00Z' },
  ],
};
it('shows the latest retry for the selected member and opens its containing conversation', () => {
  expect(recentMemberTask(activity, 'worker')).toMatchObject({
    task: { id: 'child', title: 'Worker edits' },
    state: 'completed',
    conversationTaskId: 'root',
  });
  expect(recentMemberTask(activity, 'another')).toMatchObject({
    state: 'running',
    conversationTaskId: 'root',
  });
});
it('keeps execution failure separate from connection readiness and handles unused members', () => {
  const failed = {
    ...activity,
    executionAttempts: [
      ...activity.executionAttempts,
      { assignmentId: 'b', state: 'interrupted', createdAt: '2026-10-24T05:00:00Z' },
    ],
  };
  expect(recentMemberTask(failed, 'worker')).toMatchObject({
    state: 'interrupted',
    conversationTaskId: 'other',
  });
  expect(memberExecutionLabel('interrupted')).toBe('已中断');
  expect(recentMemberTask(activity, 'unused')).toBeUndefined();
});
it('uses the reported program identity without guessing missing version or trusting non-text values', () => {
  expect(memberProgramIdentity({ name: 'adapter', title: 'Developer', version: '2.0' })).toBe(
    'Developer · v2.0',
  );
  expect(memberProgramIdentity({ name: 'adapter' })).toBe('adapter · 版本未上报');
  expect(memberProgramIdentity({ name: { injected: 'data' }, version: 123 })).toBeUndefined();
});
it('shows queued assignments before an execution attempt exists without mutating source data', () => {
  const queued = {
    tasks: [{ id: 'q', title: 'Queued' }],
    assignments: [
      {
        id: 'qa',
        taskId: 'q',
        agentId: 'worker',
        createdAt: '2026-10-24T00:00:00Z',
        state: 'queued',
      },
    ],
    executionAttempts: [],
  };
  const before = structuredClone(queued);
  expect(recentMemberTask(queued, 'worker')).toMatchObject({
    state: 'queued',
    conversationTaskId: 'q',
  });
  expect(queued).toEqual(before);
});

it('finds current work even when another task completed later, and ignores superseded attempts', () => {
  const running = structuredClone(activity);
  running.executionAttempts.find((a) => a.assignmentId === 'a' && a.state === 'completed')!.state =
    'waiting';
  running.executionAttempts.push({
    assignmentId: 'b',
    state: 'completed',
    createdAt: '2026-10-24T05:00:00Z',
  });
  expect(recentMemberTask(running, 'worker')).toMatchObject({
    task: { id: 'other' },
    state: 'completed',
  });
  expect(recentMemberTask(running, 'worker', true)).toMatchObject({
    task: { id: 'child' },
    state: 'waiting',
    conversationTaskId: 'root',
  });
  running.executionAttempts.push({
    assignmentId: 'a',
    state: 'failed',
    createdAt: '2026-10-24T06:00:00Z',
  });
  expect(recentMemberTask(running, 'worker', true)).toBeUndefined();
  expect(recentMemberTask(undefined, 'worker', true)).toBeUndefined();
});
