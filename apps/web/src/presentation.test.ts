import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  taskStateLabel,
  approvalStateLabel,
  eventLabel,
  outcomeLabel,
} from './presentation';

describe('readable protocol labels', () => {
  it('uses exact Chinese task and approval states without changing values', () => {
    expect(taskStateLabel('waiting_approval')).toBe('待审批');
    expect(taskStateLabel('failed')).toBe('失败');
    expect(taskStateLabel('completed')).toBe('已完成');
    expect(approvalStateLabel('pending')).toBe('待决定');
    expect(approvalStateLabel('approved')).toBe('已批准');
    expect(approvalStateLabel('rejected')).toBe('已拒绝');
  });
  it('explains known events and retains every unknown value verbatim', () => {
    expect(eventLabel('attempt.interrupted')).toBe('执行被中断');
    expect(eventLabel('task.retry_requested')).toBe('已请求恢复执行');
    expect(outcomeLabel('denied')).toBe('已拒绝');
    for (const value of ['vendor.custom.event', 'constructor', '__proto__', 'FAILED']) {
      for (const label of [taskStateLabel, approvalStateLabel, eventLabel, outcomeLabel])
        expect(label(value)).toBe(value);
    }
  });
});

it('keeps system, user and agent identity separate when their IDs collide', () => {
  const state = {
    generatedAt: '',
    projects: [],
    agents: [
      {
        definition: {
          id: 'task-engine',
          name: '测试执行 Agent',
          enabled: true,
          runtime: { command: 'unused', args: [] },
          orchestration: { canBeBoss: false },
          controlBridge: { transport: 'mcp', scopes: [] },
          capabilities: [],
        },
        readiness: { runtime: 'unknown', auth: 'unknown' },
        authMethods: [],
      },
    ],
    tasks: [],
    timeline: [],
    messages: [],
    approvals: [],
    artifacts: [],
    runners: [],
    workspaces: [],
  };
  expect(actorLabel({ type: 'system', id: 'task-engine' }, state)).toBe('系统 · task-engine');
  expect(actorLabel({ type: 'user', id: 'task-engine' }, state)).toBe('用户 · task-engine');
  expect(actorLabel({ type: 'agent', id: 'task-engine' }, state)).toBe('Agent · 测试执行 Agent');
  expect(actorLabel({ type: 'vendor.actor', id: 'task-engine' }, state)).toBe(
    'vendor.actor · task-engine',
  );
  expect(actorLabel({ id: 'task-engine' }, state)).toBe('task-engine');
});
