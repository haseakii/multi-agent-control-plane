import { z } from 'zod';

export const MemberActivity = z.object({
  tasks: z.array(
    z.object({ id: z.string(), title: z.string(), parentTaskId: z.string().optional() }),
  ),
  assignments: z.array(
    z.object({
      id: z.string(),
      agentId: z.string(),
      taskId: z.string(),
      createdAt: z.string(),
      state: z.string(),
    }),
  ),
  executionAttempts: z.array(
    z.object({ assignmentId: z.string(), state: z.string(), createdAt: z.string() }),
  ),
});
export type MemberActivityData = z.infer<typeof MemberActivity>;

export function recentMemberTask(
  activity: MemberActivityData | undefined,
  agentId: string,
  activeOnly = false,
) {
  if (!activity) return undefined;
  const tasks = new Map(activity.tasks.map((task) => [task.id, task]));
  const attempts = new Map<string, MemberActivityData['executionAttempts'][number]>();
  for (const attempt of activity.executionAttempts) {
    const current = attempts.get(attempt.assignmentId);
    if (!current || attempt.createdAt > current.createdAt)
      attempts.set(attempt.assignmentId, attempt);
  }
  const rows = activity.assignments
    .filter((row) => row.agentId === agentId && tasks.has(row.taskId))
    .map((row) => {
      const latest = attempts.get(row.id);
      return {
        task: tasks.get(row.taskId)!,
        state: latest?.state ?? row.state,
        at: latest?.createdAt ?? row.createdAt,
      };
    })
    .filter((row) => !activeOnly || ['queued', 'running', 'waiting'].includes(row.state))
    .sort((a, b) => b.at.localeCompare(a.at));
  const latest = rows[0];
  if (!latest) return undefined;
  let conversationTask = latest.task;
  const seen = new Set([conversationTask.id]);
  while (conversationTask.parentTaskId) {
    const parent = tasks.get(conversationTask.parentTaskId);
    if (!parent || seen.has(parent.id)) return undefined;
    seen.add(parent.id);
    conversationTask = parent;
  }
  return { ...latest, conversationTaskId: conversationTask.id };
}
export function memberProgramIdentity(info: unknown) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const data = info as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
  const name = text(data.title) ?? text(data.name),
    version = text(data.version);
  if (!name && !version) return undefined;
  return [name ?? 'ACP 程序', version ? `v${version}` : '版本未上报'].join(' · ');
}
export const memberExecutionLabel = (state: string) =>
  ({
    queued: '等待执行',
    running: '执行中',
    waiting: '等待处理',
    completed: '已完成',
    failed: '失败',
    cancelled: '已停止',
    interrupted: '已中断',
  })[state] ?? '状态未识别';
