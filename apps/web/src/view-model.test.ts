import { describe, expect, it } from 'vitest';
import {
  isRoutineEvent,
  taskActionEligibility,
  taskFamily,
  messageInTaskScope,
  messageResponse,
  type Snapshot,
  type Task,
} from './view-model';

const task: Task = {
  id: 'root',
  projectId: 'p',
  title: 'Goal',
  objective: 'Review',
  state: 'failed',
  resultArtifactRefs: [],
};
function snapshot(): Snapshot {
  return {
    generatedAt: '2026-10-21T00:00:00Z',
    projects: [],
    tasks: [task],
    agents: [
      {
        definition: {
          id: 'a',
          name: 'a',
          enabled: true,
          runtime: { command: 'unused', args: [] },
          orchestration: { canBeBoss: true },
          controlBridge: { transport: 'mcp', scopes: [] },
          capabilities: [],
        },
        readiness: { runtime: 'ready', auth: 'unknown' },
        authMethods: [],
      },
    ],
    assignments: [{ id: 'assignment', taskId: 'root', agentId: 'a', attempt: 1 }],
    executionAttempts: [
      {
        id: 'attempt',
        taskId: 'root',
        assignmentId: 'assignment',
        number: 1,
        state: 'failed',
        failure: { retryable: true, code: 'EXECUTION_FAILED', message: 'Execution failed.' },
      },
    ],
    timeline: [],
    messages: [],
    approvals: [],
    artifacts: [],
    runners: [],
    workspaces: [],
  };
}
describe('task workbench view model', () => {
  it('offers recovery only for the latest eligible attempt, and never cancellation for failure', () => {
    const state = snapshot();
    expect(taskActionEligibility(task, state)).toMatchObject({ canCancel: false, canResume: true });
    state.executionAttempts![0]!.failure!.retryable = false;
    expect(taskActionEligibility(task, state).canResume).toBe(false);
    state.executionAttempts![0]!.state = 'interrupted';
    delete state.executionAttempts![0]!.failure;
    state.assignments![0]!.attempt = 2;
    expect(taskActionEligibility(task, state).canResume).toBe(false);
  });
  it('does not invent eligibility when metadata is absent or a dependency is incomplete', () => {
    const state = snapshot();
    expect(taskActionEligibility({ ...task, dependencyIds: ['missing'] }, state).canResume).toBe(
      false,
    );
    delete state.executionAttempts;
    expect(taskActionEligibility(task, state).canResume).toBe(false);
  });
  it('blocks terminal tasks and active execution races while permitting cancellation of active tasks', () => {
    const state = snapshot();
    for (const status of ['completed', 'cancelled'])
      expect(taskActionEligibility({ ...task, state: status }, state)).toMatchObject({
        canCancel: false,
        canResume: false,
      });
    state.executionAttempts!.push({
      ...state.executionAttempts![0]!,
      id: 'active',
      number: 2,
      state: 'running',
    });
    expect(taskActionEligibility(task, state).canResume).toBe(false);
    expect(taskActionEligibility({ ...task, state: 'waiting_approval' }, state).canCancel).toBe(
      true,
    );
  });
  it('keeps descendant scope finite even with malformed cycles, and exposes exceptional tool events', () => {
    expect([
      ...taskFamily(
        [
          task,
          { ...task, id: 'child', parentTaskId: 'root' },
          { ...task, id: 'root', parentTaskId: 'child' },
        ],
        'root',
      ),
    ]).toEqual(['root', 'child']);
    const event = {
      id: 'e',
      projectId: 'p',
      type: 'fleet.tool',
      occurredAt: '',
      actor: { id: 'a' },
    };
    expect(isRoutineEvent(event)).toBe(true);
    expect(isRoutineEvent({ ...event, payload: { outcome: 'denied' } })).toBe(false);
  });
});

it('includes a routed result from an independent task in the sender scope without crossing projects', () => {
  const message = {
    id: 'reply',
    projectId: 'p',
    taskId: 'other-task',
    fromAgentId: 'b',
    toAgentId: 'a',
    type: 'response',
    createdAt: '',
    metadata: { parentTaskId: 'root' },
  };
  expect(messageInTaskScope(message, 'p', new Set(['root']))).toBe(true);
  expect(
    messageInTaskScope({ ...message, projectId: 'other-project' }, 'p', new Set(['root'])),
  ).toBe(false);
  expect(messageInTaskScope({ ...message, metadata: {} }, 'p', new Set(['root']))).toBe(false);
  expect(
    messageInTaskScope(
      {
        id: 'project-msg',
        projectId: 'p',
        fromAgentId: 'b',
        type: 'message',
        createdAt: '',
        metadata: { senderTaskId: 'other-task' },
      },
      'p',
      new Set(['root']),
    ),
  ).toBe(false);
});

it('matches responses by request and bound agent pair instead of guessing from nearby messages', () => {
  const request = {
    id: 'q',
    projectId: 'p',
    fromAgentId: 'a',
    toAgentId: 'b',
    type: 'request',
    createdAt: '',
  };
  const reply = {
    id: 'r',
    projectId: 'p',
    fromAgentId: 'b',
    toAgentId: 'a',
    type: 'response',
    replyTo: 'q',
    createdAt: '',
  };
  expect(
    messageResponse(request, [
      { ...reply, fromAgentId: 'c' },
      { ...reply, projectId: 'other' },
      reply,
    ]),
  ).toEqual(reply);
  expect(messageResponse(request, [{ ...reply, toAgentId: 'c' }])).toBeUndefined();
});
