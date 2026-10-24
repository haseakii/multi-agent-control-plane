import { expect, it } from 'vitest';
import { attemptNotices, toolOutcome, toolPresentation } from '../src/activity-presentation';

it('uses reported outcomes instead of stale Running titles in completed and retried tool records', () => {
  expect(toolPresentation('Running view_file', 'completed', 'completed')).toEqual({
    label: '读取文件',
    outcome: 'done',
    status: '已完成',
  });
  expect(toolPresentation('Running edit_file', 'failed', 'completed')).toEqual({
    label: '修改文件',
    outcome: 'error',
    status: 'Agent 报告失败',
  });
  expect(toolPresentation('Running edit_file', 'in_progress', 'failed', 'running')).toEqual({
    label: '修改文件',
    outcome: 'unreported',
    status: '执行已结束，结果未知',
  });
  expect(toolPresentation('functions.control_delegate_task', 'pending', 'running')).toEqual({
    label: '委派协作任务',
    outcome: 'running',
    status: '等待执行',
  });
  expect(toolPresentation('Running view_file', 'in_progress', 'running')).toEqual({
    label: '读取文件',
    outcome: 'awaiting_report',
    status: '已请求，等待结果上报',
  });
  expect(toolPresentation('Running read_file', 'in_progress', 'running').outcome).toBe(
    'awaiting_report',
  );
  expect(toolPresentation('Running view_file', 'failed', 'running').outcome).toBe('error');
  expect(toolPresentation('Running edit_file', 'in_progress', 'running').outcome).toBe('running');
});

it('preserves unrecognized tool descriptions without deriving status from their wording', () => {
  for (const title of [
    'Running custom_tool',
    'Read file failed: view_file',
    'file.with.dots',
    '',
  ]) {
    expect(toolPresentation(title, 'in_progress', 'completed')).toEqual({
      label: title,
      outcome: 'unreported',
      status: '执行已结束，结果未知',
    });
  }
});

it('keeps missing tool outcomes unknown for every terminal attempt, independent of the retry', () => {
  for (const state of ['failed', 'interrupted', 'cancelled', 'completed']) {
    expect(toolOutcome('in_progress', state, 'running')).toBe('unreported');
    expect(toolOutcome('pending', state, 'completed')).toBe('unreported');
    expect(toolOutcome('completed', state)).toBe('done');
    expect(toolOutcome('failed', state)).toBe('error');
  }
  expect(toolOutcome('in_progress', 'running', 'failed')).toBe('running');
  expect(toolOutcome('in_progress', undefined, 'failed')).toBe('unreported');
});

it('retains the original failure and a separate retry boundary after recovery completes', () => {
  const first = {
    id: 'first',
    number: 1,
    state: 'failed',
    finishedAt: '2026-10-24T01:00:00Z',
    failure: { code: 'ACP_CONNECTION_CLOSED', message: 'closed', retryable: true },
  };
  const retry = { id: 'second', number: 2, state: 'completed', startedAt: '2026-10-24T01:01:00Z' };
  const records = attemptNotices([first, retry], 'Worker');
  expect(records).toHaveLength(2);
  expect(records[0]?.text).toContain('第 1 次执行失败');
  expect(records[0]?.text).toContain('连接在任务完成前断开');
  expect(records[1]?.text).toContain('第 2 次执行');
  expect(records[0]?.createdAt).toBeLessThan(records[1]!.createdAt);
  expect(records[0]?.text).not.toContain('登录');
  expect(records[0]?.text).not.toContain('点击');
  expect(attemptNotices([first], 'Worker')[0]).toEqual(records[0]);
});
