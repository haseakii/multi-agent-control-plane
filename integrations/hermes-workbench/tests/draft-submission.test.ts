import { describe, expect, it, vi } from 'vitest';
import {
  submitDraft,
  type DraftGateway,
  type DraftRecord,
  type DraftSubmission,
} from '../src/draft-submission';

type Task = { id: string; objective: string };

function fixture() {
  let record: DraftRecord<Task> = {
    task: { id: 'draft-1', objective: '旧目标' },
    version: 'a'.repeat(64),
    canEditObjective: true,
    reason: '',
  };
  const gateway = {
    create: vi.fn(async (_projectId: string, _objective: string) => record.task),
    read: vi.fn(async (_taskId: string) => record),
    update: vi.fn(async (_taskId: string, objective: string, _version: string) => {
      record = {
        ...record,
        task: { ...record.task, objective },
        version: 'b'.repeat(64),
      };
      return record;
    }),
    selectBoss: vi.fn(async (_projectId: string) => undefined),
    start: vi.fn(async (_taskId: string, _version: string) => record.task),
  } satisfies DraftGateway<Task>;
  return { gateway, setRecord: (next: DraftRecord<Task>) => (record = next) };
}

describe('daily task submission', () => {
  it('reuses the same creation request after a lost response while allowing the goal to be edited', async () => {
    const { gateway } = fixture();
    const submission: DraftSubmission = { projectId: 'p' };
    const saved: DraftSubmission[] = [];
    gateway.create.mockRejectedValueOnce(new Error('response lost'));
    await expect(
      submitDraft('旧目标', submission, gateway, () => saved.push({ ...submission })),
    ).rejects.toThrow('response lost');
    expect(saved[0]?.createKey).toBeTruthy();
    const reloaded = JSON.parse(JSON.stringify(saved[0])) as DraftSubmission;
    await submitDraft('修改后的目标', reloaded, gateway);
    expect(gateway.create.mock.calls[1]).toEqual(gateway.create.mock.calls[0]);
    expect(gateway.update).toHaveBeenCalledWith('draft-1', '修改后的目标', 'a'.repeat(64));
    expect(gateway.start).toHaveBeenCalledTimes(1);
  });
  it('starts a direct task without selecting or replacing the project Boss', async () => {
    const { gateway } = fixture();
    const { selectBoss: _unused, ...direct } = gateway;
    await submitDraft('直接处理', { projectId: 'p' }, direct);
    expect(gateway.selectBoss).not.toHaveBeenCalled();
    expect(gateway.start).toHaveBeenCalledWith('draft-1', 'b'.repeat(64));
  });
  it('starts the edited goal in the same saved draft after a failed send', async () => {
    const { gateway } = fixture();
    const submission: DraftSubmission = { projectId: 'project-1' };
    gateway.start.mockRejectedValueOnce(new Error('启动响应失败'));

    await expect(submitDraft('旧目标', submission, gateway)).rejects.toThrow('启动响应失败');
    const result = await submitDraft('修改后的目标', submission, gateway);

    expect(result.objective).toBe('修改后的目标');
    expect(gateway.create).toHaveBeenCalledTimes(1);
    expect(gateway.update).toHaveBeenCalledWith('draft-1', '修改后的目标', 'a'.repeat(64));
    expect(gateway.start).toHaveBeenLastCalledWith('draft-1', 'b'.repeat(64));
    expect(gateway.selectBoss).toHaveBeenCalledTimes(2);
    expect(submission.taskId).toBe('draft-1');
  });

  it('keeps the saved draft and does not start when its version changed', async () => {
    const { gateway } = fixture();
    const submission = { projectId: 'project-1', taskId: 'draft-1' };
    gateway.update.mockRejectedValueOnce(new Error('任务已更新'));

    await expect(submitDraft('修改后的目标', submission, gateway)).rejects.toThrow('任务已更新');

    expect(submission.taskId).toBe('draft-1');
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.selectBoss).not.toHaveBeenCalled();
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it('does not rewrite or restart a draft that already entered execution', async () => {
    const { gateway, setRecord } = fixture();
    setRecord({
      task: { id: 'draft-1', objective: '旧目标' },
      version: 'c'.repeat(64),
      canEditObjective: false,
      reason: '任务已经启动，请在会话中补充。',
    });

    await expect(
      submitDraft('修改后的目标', { projectId: 'project-1', taskId: 'draft-1' }, gateway),
    ).rejects.toThrow('任务已经启动');

    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.update).not.toHaveBeenCalled();
    expect(gateway.selectBoss).not.toHaveBeenCalled();
    expect(gateway.start).not.toHaveBeenCalled();
  });
});
