import { expect, it } from 'vitest';
import {
  executionRecordUrl,
  executionTaskScope,
  executionEventNeedsAttention,
  isRoutineExecutionEvent,
} from '../src/execution-view';

it('requests only the current conversation, including all its rounds from the server', () => {
  expect(executionRecordUrl(['root/one', 'followup'])).toBe(
    '/api/control-center?view=conversation&taskId=root%2Fone',
  );
  expect(executionRecordUrl([])).toBe('/api/control-center?view=conversation');
});

it('keeps delegated descendants within a selected round without mixing another round or conversation', () => {
  const tasks = [
    { id: 'first' },
    { id: 'second' },
    { id: 'other' },
    { id: 'nested', parentTaskId: 'child' },
    { id: 'child', parentTaskId: 'first' },
    { id: 'later-child', parentTaskId: 'second' },
    { id: 'unrelated-child', parentTaskId: 'other' },
  ];
  expect([...executionTaskScope(['first', 'second'], tasks, 'first')].sort()).toEqual([
    'child',
    'first',
    'nested',
  ]);
  expect([...executionTaskScope(['first', 'second'], tasks, 'second')].sort()).toEqual([
    'later-child',
    'second',
  ]);
  expect([...executionTaskScope(['first', 'second'], tasks, 'stale')].sort()).toEqual([
    'child',
    'first',
    'later-child',
    'nested',
    'second',
  ]);
});

it('keeps failed tools, interrupted replies and blocked or denied operations in the visible milestones', () => {
  for (const event of [
    { type: 'agent.tool', payload: { status: 'failed' } },
    { type: 'agent.progress', payload: { state: 'interrupted' } },
    { type: 'fleet.tool', payload: { outcome: 'denied' } },
    { type: 'task.state_changed', payload: { to: 'blocked' } },
    { type: 'message.delivery_failed' },
    { type: 'approval.decided', payload: { state: 'rejected' } },
  ]) {
    expect(executionEventNeedsAttention(event)).toBe(true);
    expect(isRoutineExecutionEvent(event)).toBe(false);
  }
});

it('folds routine progress without dropping lifecycle, retry, review and workspace handoff milestones', () => {
  for (const type of [
    'agent.progress',
    'agent.tool',
    'agent.usage',
    'client.tool.called',
    'message.delivered',
  ])
    expect(isRoutineExecutionEvent({ type })).toBe(true);
  for (const type of [
    'task.created',
    'task.followup.created',
    'task.retry_requested',
    'execution.failed',
    'attempt.finished',
    'workspace.continued',
    'workspace.review.prepared',
    'approval.requested',
  ])
    expect(isRoutineExecutionEvent({ type })).toBe(false);
});
