import { createHash, randomUUID } from 'node:crypto';
import {
  TaskSchema,
  TaskRecordViewSchema,
  TaskRecordUpdateSchema,
  TaskRecordConfirmationSchema,
  type Task,
} from '@control-plane/core';
import type { StorageRepositories } from '@control-plane/storage';
import { TaskControlError } from './task-control-error.js';

/** Operator record management, separate from execution/session state and filesystem cleanup. */
export class TaskRecords {
  constructor(private readonly store: StorageRepositories) {}

  inspect(taskId: string) {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new TaskControlError(404, 'Task not found.');
    const unassigned = !this.store.assignments.list().some((row) => row.taskId === taskId);
    const editable = task.state === 'draft' && unassigned && !task.parentTaskId;
    const referenced =
      !unassigned ||
      Boolean(task.parentTaskId) ||
      task.dependencyIds.length > 0 ||
      task.contextRefs.length > 0 ||
      task.resultArtifactRefs.length > 0 ||
      this.store.tasks
        .list()
        .some((row) => row.parentTaskId === taskId || row.dependencyIds.includes(task.id)) ||
      this.store.executionAttempts.list().some((row) => row.taskId === taskId) ||
      this.store.conversations.list().some((row) => row.taskId === taskId) ||
      this.store.messages
        .list()
        .some((row) => row.taskId === taskId || Object.values(row.metadata).includes(taskId)) ||
      this.store.artifacts.list().some((row) => row.taskId === taskId) ||
      this.store.approvals.list().some((row) => row.taskId === taskId) ||
      this.store.taskInstructions.list().some((row) => row.taskId === taskId) ||
      this.store.projectMemory.list().some((row) => row.sourceTaskId === taskId) ||
      this.store.assignmentWorkspaces.list().some((row) => row.taskId === taskId) ||
      this.store.workspaceReviews.list().some((row) => row.taskId === taskId) ||
      this.store.workspacePushes.list().some((row) => row.taskId === taskId) ||
      this.store.workspaceCleanups.list().some((row) => row.taskId === taskId);
    return TaskRecordViewSchema.parse({
      task,
      version: createHash('sha256').update(JSON.stringify(task)).digest('hex'),
      canEditObjective: editable,
      canDelete: editable && !referenced,
      reason: !editable
        ? '任务已进入执行流程，保留目标与历史；可以修改显示标题。'
        : referenced
          ? '草稿被其他记录引用，不能删除。'
          : '草稿尚未执行，可以修改或删除；启动后保留执行历史。',
    });
  }

  confirm(taskId: string, version: string) {
    const view = this.inspect(taskId);
    if (view.version !== version)
      throw new TaskControlError(409, '任务已更新，请重新查看后再操作。');
    return view;
  }

  update(taskId: string, input: unknown) {
    const change = TaskRecordUpdateSchema.parse(input);
    return this.store.transaction(() => {
      const view = this.confirm(taskId, change.version);
      if (change.objective !== undefined && !view.canEditObjective)
        throw new TaskControlError(409, '执行目标已固定，请使用任务指令补充要求。');
      const task = TaskSchema.parse({
        ...view.task,
        ...(change.title !== undefined ? { title: change.title } : {}),
        ...(change.objective !== undefined ? { objective: change.objective } : {}),
        updatedAt: new Date().toISOString(),
      });
      this.store.tasks.upsert(task);
      this.audit(task, 'task.record_updated', {
        previousTitle: view.task.title,
        title: task.title,
        ...(change.objective !== undefined
          ? { previousObjective: view.task.objective, objective: task.objective }
          : {}),
      });
      return this.inspect(taskId);
    });
  }

  delete(taskId: string, input: unknown) {
    const { version } = TaskRecordConfirmationSchema.parse(input);
    return this.store.transaction(() => {
      const view = this.confirm(taskId, version);
      if (!view.canDelete) throw new TaskControlError(409, view.reason);
      this.audit(view.task, 'task.draft_deleted', { title: view.task.title });
      this.store.tasks.delete(taskId);
      return { deleted: true, taskId };
    });
  }

  private audit(task: Task, type: string, payload: Record<string, unknown>) {
    this.store.events.append({
      id: 'event-' + randomUUID(),
      projectId: task.projectId,
      taskId: task.id,
      type,
      actor: { type: 'user', id: 'local-operator' },
      payload,
      occurredAt: new Date().toISOString(),
    });
  }
}
