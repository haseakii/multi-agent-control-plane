import React from 'react';
import {
  canResumeTask,
  taskAgentName,
  taskFamily,
  terminal,
  type SnapshotData,
  type TaskData,
} from './adapter';
import s from './workbench.module.css';
import { failureSummary } from './failure-presentation';

/** Presentation only: every recovery still uses the engine's existing eligibility checks. */
export function TaskFeedback({
  snapshot,
  task,
  disabled,
  onInspect,
  onConnections,
  onResume,
}: {
  snapshot: SnapshotData;
  task: TaskData;
  disabled: boolean;
  onInspect: () => void;
  onConnections: () => void;
  onResume: (task: TaskData) => void;
}) {
  const family = terminal(task)
    ? task.state === 'failed'
      ? [task]
      : []
    : taskFamily(snapshot, task);
  const problems = family.flatMap((member) => {
    if (!['failed', 'blocked', 'waiting', 'ready'].includes(member.state)) return [];
    const assignment = snapshot.assignments.filter((item) => item.taskId === member.id).at(-1);
    const attempt = snapshot.executionAttempts
      .filter((item) => item.assignmentId === assignment?.id)
      .sort((a, b) => b.number - a.number)[0];
    if (
      member.state !== 'failed' &&
      member.state !== 'blocked' &&
      !['failed', 'interrupted'].includes(attempt?.state ?? '')
    )
      return [];
    return [{ task: member, attempt, resumable: canResumeTask(snapshot, member) }];
  });
  if (!problems.length) return null;
  return (
    <section className={s.taskFeedback} aria-label="需要处理的任务">
      {problems.map((problem) => (
        <article key={problem.task.id}>
          <strong>
            {problem.task.id === task.id
              ? '当前任务需要处理'
              : `协作任务需要处理：${problem.task.title}`}
          </strong>
          <p>
            {taskAgentName(snapshot, problem.task) ?? '执行成员'} ·{' '}
            {problem.task.state === 'blocked' && !problem.attempt?.failure
              ? '任务暂时无法继续。请查看依赖任务或执行过程，处理阻塞原因后再继续。'
              : failureSummary(problem.attempt?.failure?.message, problem.attempt?.failure?.code)}
          </p>
          {problem.attempt?.failure?.message && (
            <details>
              <summary>错误详情</summary>
              <pre>
                {problem.attempt.failure.code ? `${problem.attempt.failure.code}\n` : ''}
                {problem.attempt.failure.message}
              </pre>
            </details>
          )}
          <div>
            {problem.resumable && (
              <button disabled={disabled} onClick={() => onResume(problem.task)}>
                保留改动并重试
              </button>
            )}
            <button onClick={onInspect}>查看执行过程</button>
            <button onClick={onConnections}>检查协作成员</button>
          </div>
        </article>
      ))}
    </section>
  );
}
