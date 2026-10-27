import { describe, expect, it } from 'vitest';
import {
  executionCardSummary,
  extractStepTarget,
  formatDuration,
  formatTimer,
  resolveDelegation,
  stateLabel,
  stripStepTarget,
} from '../src/live-execution-model';

describe('formatDuration', () => {
  it('formats zero and invalid ms', () => {
    expect(formatDuration(0)).toBe('0秒');
    expect(formatDuration(-100)).toBe('0秒');
    expect(formatDuration(NaN)).toBe('0秒');
    expect(formatDuration(Infinity)).toBe('0秒');
  });

  it('formats sub-second duration', () => {
    expect(formatDuration(300)).toBe('<1秒');
    expect(formatDuration(800)).toBe('1秒');
  });

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5秒');
    expect(formatDuration(45000)).toBe('45秒');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1分');
    expect(formatDuration(90000)).toBe('1分30秒');
    expect(formatDuration(125000)).toBe('2分5秒');
  });

  it('formats hours', () => {
    expect(formatDuration(3600000)).toBe('1小时');
    expect(formatDuration(4200000)).toBe('1小时10分');
    expect(formatDuration(7200000)).toBe('2小时');
  });
});

describe('formatTimer', () => {
  it('formats zero and negative values', () => {
    expect(formatTimer(0)).toBe('00:00');
    expect(formatTimer(-500)).toBe('00:00');
    expect(formatTimer(NaN)).toBe('00:00');
  });

  it('formats mm:ss', () => {
    expect(formatTimer(4000)).toBe('00:04');
    expect(formatTimer(65000)).toBe('01:05');
    expect(formatTimer(599000)).toBe('09:59');
  });

  it('formats hh:mm:ss when over an hour', () => {
    expect(formatTimer(3600000)).toBe('01:00:00');
    expect(formatTimer(3665000)).toBe('01:01:05');
  });
});

describe('extractStepTarget', () => {
  it('extracts target after colon separator', () => {
    expect(extractStepTarget('Running view_file: src/main.tsx')).toBe('src/main.tsx');
    expect(extractStepTarget('Running run_command: pnpm test')).toBe('pnpm test');
    expect(extractStepTarget('view_file: path/to/file.ts')).toBe('path/to/file.ts');
  });

  it('extracts target inside parentheses', () => {
    expect(extractStepTarget('Running edit_file (packages/core/src/index.ts)')).toBe(
      'packages/core/src/index.ts',
    );
  });

  it('returns undefined for pure tool titles without target parameters', () => {
    expect(extractStepTarget('Running view_file')).toBeUndefined();
    expect(extractStepTarget('view_file')).toBeUndefined();
    expect(extractStepTarget('')).toBeUndefined();
  });
});

describe('stripStepTarget', () => {
  it('strips colon parameters leaving base tool name', () => {
    expect(stripStepTarget('Running view_file: src/main.tsx')).toBe('Running view_file');
    expect(stripStepTarget('Running run_command: pnpm test')).toBe('Running run_command');
    expect(stripStepTarget('view_file: path/to/file.ts')).toBe('view_file');
  });

  it('strips parentheses parameters leaving base tool name', () => {
    expect(stripStepTarget('Running edit_file (packages/core/src/index.ts)')).toBe(
      'Running edit_file',
    );
  });

  it('preserves clean tool titles without target parameters', () => {
    expect(stripStepTarget('Running view_file')).toBe('Running view_file');
    expect(stripStepTarget('view_file')).toBe('view_file');
    expect(stripStepTarget('Guardian Review')).toBe('Guardian Review');
  });
});

describe('resolveDelegation', () => {
  const snapshot = {
    agents: [
      { definition: { id: 'boss', name: '调度 Boss' } },
      { definition: { id: 'coder', name: '编程助手' } },
    ],
    assignments: [
      { id: 'a1', taskId: 'root-task', agentId: 'boss' },
      { id: 'a2', taskId: 'sub-task', agentId: 'coder' },
    ],
  };

  it('detects single agent without active child tasks', () => {
    const delegation = resolveDelegation({
      snapshot,
      root: { id: 'root-task', ownerAgentId: 'boss' },
      family: [{ id: 'root-task', title: '主任务', state: 'running', ownerAgentId: 'boss' }],
    });
    expect(delegation.hasDelegation).toBe(false);
    expect(delegation.leaderName).toBe('调度 Boss');
  });

  it('detects multi-agent delegation with active child task', () => {
    const delegation = resolveDelegation({
      snapshot,
      root: { id: 'root-task', ownerAgentId: 'boss' },
      family: [
        { id: 'root-task', title: '主任务', state: 'waiting_children', ownerAgentId: 'boss' },
        {
          id: 'sub-task',
          parentTaskId: 'root-task',
          title: '编写测试',
          state: 'running',
          ownerAgentId: 'coder',
        },
      ],
    });
    expect(delegation.hasDelegation).toBe(true);
    expect(delegation.leaderName).toBe('调度 Boss');
    expect(delegation.workerName).toBe('编程助手');
    expect(delegation.subtaskTitle).toBe('编写测试');
  });
});

describe('executionCardSummary', () => {
  it('produces single emoji icon and clean summary text for completed task', () => {
    const summary = executionCardSummary({
      state: 'completed',
      durationMs: 15000,
      collaboratorsCount: 2,
      stepCount: 4,
    });
    expect(summary.status).toBe('completed');
    expect(summary.icon).toBe('⚡');
    expect(summary.text).toBe('本轮执行完毕 · 耗时 15秒 · 2 个协作者 · 4 项步骤');
    // Ensure the text itself does not duplicate the emoji
    expect(summary.text.startsWith('⚡')).toBe(false);
  });

  it('includes delegation and artifact counts when provided', () => {
    const summary = executionCardSummary({
      state: 'completed',
      durationMs: 20000,
      collaboratorsCount: 2,
      stepCount: 5,
      artifactsCount: 2,
      delegation: {
        leaderName: 'Boss',
        workerName: '代码助手',
        hasDelegation: true,
      },
    });
    expect(summary.text).toBe(
      '本轮执行完毕 · 耗时 20秒 · 2 个协作者（Boss ➜ 代码助手） · 5 项步骤 · 2 个产物',
    );
  });

  it('handles failed tasks with warning icon and failure reason', () => {
    const summary = executionCardSummary({
      state: 'failed',
      durationMs: 8000,
      collaboratorsCount: 1,
      stepCount: 2,
      failureReason: '成员响应超时',
    });
    expect(summary.status).toBe('failed');
    expect(summary.icon).toBe('⚠️');
    expect(summary.text).toBe('本轮执行失败 · 耗时 8秒 · 2 项步骤');
    expect(summary.failureReason).toBe('成员响应超时');
    expect(summary.text.startsWith('⚠️')).toBe(false);
  });

  it('handles cancelled tasks specifically', () => {
    const summary = executionCardSummary({
      state: 'cancelled',
      durationMs: 3000,
      collaboratorsCount: 1,
      stepCount: 1,
    });
    expect(summary.status).toBe('failed');
    expect(summary.icon).toBe('⚠️');
    expect(summary.text).toBe('本轮已取消 · 耗时 3秒 · 1 项步骤');
  });

  it('handles blocked tasks with paused status and icon', () => {
    const summary = executionCardSummary({
      state: 'blocked',
      durationMs: 12000,
      collaboratorsCount: 1,
      stepCount: 3,
    });
    expect(summary.status).toBe('blocked');
    expect(summary.icon).toBe('⏸');
    expect(summary.text).toBe('任务已暂停 · 已耗时 12秒 · 3 项步骤');
  });

  it('translates known and unknown states in stateLabel', () => {
    expect(stateLabel('ready')).toBe('就绪');
    expect(stateLabel('waiting')).toBe('等待中');
    expect(stateLabel('waiting_children')).toBe('等待协作');
    expect(stateLabel('running')).toBe('执行中');
    expect(stateLabel('custom_state')).toBe('custom_state');
  });
});
