import { expect, it } from 'vitest';
import { pendingTaskApprovals } from '../src/conversation-scope';

it('shows requests from the current task and its workers without mixing other conversations', () => {
  const current = { id: 'current', projectId: 'project-1' };
  const tasks = [
    current,
    { id: 'nested', projectId: 'project-1', parentTaskId: 'worker' },
    { id: 'worker', projectId: 'project-1', parentTaskId: 'current' },
    { id: 'other', projectId: 'project-1' },
    { id: 'previous-round', projectId: 'project-1' },
  ];
  const request = (id: string, taskId?: string, projectId = 'project-1', state = 'pending') => ({
    id,
    taskId,
    projectId,
    state,
  });
  const approvals = [
    request('boss-request', 'current'),
    request('worker-request', 'worker'),
    request('nested-request', 'nested'),
    request('other-conversation', 'other'),
    request('old-round', 'previous-round'),
    request('project-only'),
    request('other-project', 'current', 'project-2'),
    request('already-decided', 'current', 'project-1', 'approved'),
  ];

  expect(pendingTaskApprovals(approvals, tasks, current).map((approval) => approval.id)).toEqual([
    'boss-request',
    'worker-request',
    'nested-request',
  ]);
  expect(pendingTaskApprovals(approvals, tasks, undefined)).toEqual([]);
});
