import { createHash, randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  ConfirmWorkspaceCleanupSchema,
  WorkspaceCleanupSchema,
  WorkspaceCleanupPreviewSchema,
  type AuditEvent,
  type AssignmentWorkspace,
  type Task,
  type Workspace,
  type WorkspaceReview,
  type WorkspaceCleanup,
  type WorkspaceCleanupPlan,
  type WorkspaceCleanupPreview,
} from '@control-plane/core';
import { WorkspaceReviewError } from './git-review.js';

export interface WorkspaceCleanupStore {
  task(id: string): Task | undefined;
  bindings(taskId: string): AssignmentWorkspace[];
  workspace(id: string): Workspace | undefined;
  reviews(taskId: string): WorkspaceReview[];
  get(workspaceId: string): WorkspaceCleanup | undefined;
  save(record: WorkspaceCleanup): void;
  audit(event: AuditEvent): void;
  transaction<T>(operation: () => T): T;
}
export interface WorkspaceCleanupAdapter {
  prepare(
    binding: AssignmentWorkspace,
    workspace: Workspace,
    source: Workspace,
    reviews: WorkspaceReview[],
  ): Promise<WorkspaceCleanupPlan>;
  remove(plan: WorkspaceCleanupPlan, source: Workspace): Promise<void>;
  /** Recovery only: refuse if any directory or Git worktree registration still exists. */
  finish(plan: WorkspaceCleanupPlan, source: Workspace): Promise<void>;
  exists(plan: WorkspaceCleanupPlan): Promise<boolean>;
}
const fingerprint = (plan: WorkspaceCleanupPlan) =>
  createHash('sha256').update(JSON.stringify(plan)).digest('hex');

export class WorkspaceCleanupService {
  constructor(
    private readonly store: WorkspaceCleanupStore,
    private readonly adapter: WorkspaceCleanupAdapter,
    private readonly now: () => string,
  ) {}
  private context(taskId: string) {
    const task = this.store.task(taskId);
    if (!task) throw new WorkspaceReviewError('任务不存在。');
    const binding = this.store.bindings(taskId).at(-1);
    const workspace = binding && this.store.workspace(binding.workspaceId);
    const source = binding && this.store.workspace(binding.sourceWorkspaceId);
    if (!binding || !workspace || !source)
      throw new WorkspaceReviewError('此任务没有已绑定的工作区。');
    return { task, binding, workspace, source };
  }
  async preview(
    taskId: string,
    validateSource: (source: Workspace) => Promise<void>,
  ): Promise<WorkspaceCleanupPreview> {
    const { task, binding, workspace, source } = this.context(taskId);
    const record = this.store.get(workspace.id);
    const base = { workspaceId: workspace.id, rootPath: workspace.rootPath, record };
    const blockers: string[] = [];
    if (!['completed', 'failed', 'cancelled'].includes(task.state))
      blockers.push('请等待任务结束后清理。');
    if (binding.mode === 'shared-directory' || workspace.id === source.id)
      blockers.push('共享目录和项目源目录不能由任务清理。');
    if (record?.state === 'completed')
      return WorkspaceCleanupPreviewSchema.parse({
        ...base,
        eligible: false,
        blockers: ['此工作区已清理；任务、审阅和产物历史仍保留。'],
      });
    if (record)
      blockers.push('上次清理未完成；请核对目录后使用“检查并收尾”，不会自动重复删除目录。');
    if (blockers.length)
      return WorkspaceCleanupPreviewSchema.parse({ ...base, eligible: false, blockers });
    try {
      await validateSource(source);
      const plan = await this.adapter.prepare(
        binding,
        workspace,
        source,
        this.store.reviews(taskId),
      );
      return WorkspaceCleanupPreviewSchema.parse({
        ...base,
        eligible: true,
        blockers,
        plan,
        confirmationHash: fingerprint(plan),
      });
    } catch (error) {
      return WorkspaceCleanupPreviewSchema.parse({
        ...base,
        eligible: false,
        blockers: [
          error instanceof WorkspaceReviewError
            ? error.message
            : '工作区检查未通过，请核对目录及 Git 状态。',
        ],
      });
    }
  }
  async execute(
    taskId: string,
    input: unknown,
    validateSource: (source: Workspace) => Promise<void>,
  ) {
    const confirmed = ConfirmWorkspaceCleanupSchema.parse(input);
    const preview = await this.preview(taskId, validateSource);
    if (
      !preview.eligible ||
      !preview.plan ||
      confirmed.confirmedWorkspaceId !== preview.workspaceId ||
      confirmed.confirmationHash !== preview.confirmationHash
    )
      throw new WorkspaceReviewError('清理条件或内容已变化，请刷新预览并重新确认。');
    const { task, source } = this.context(taskId);
    const at = this.now();
    const record = WorkspaceCleanupSchema.parse({
      id: preview.workspaceId,
      projectId: task.projectId,
      taskId,
      plan: preview.plan,
      confirmationHash: preview.confirmationHash,
      state: 'removing',
      createdAt: at,
      updatedAt: at,
    });
    this.save(record);
    try {
      await this.adapter.remove(record.plan, source);
      return this.save({ ...record, state: 'completed', updatedAt: this.now() });
    } catch {
      this.save({
        ...record,
        state: 'failed',
        updatedAt: this.now(),
        failure: '清理未确认完成；请检查目录与 Git 引用，不会自动重复删除。',
      });
      throw new WorkspaceReviewError('清理未确认完成，请使用检查并收尾查看结果。');
    }
  }
  async recover(
    taskId: string,
    input: unknown,
    validateSource: (source: Workspace) => Promise<void>,
  ) {
    const confirmed = ConfirmWorkspaceCleanupSchema.parse(input);
    const { task, workspace, source } = this.context(taskId);
    const record = this.store.get(workspace.id);
    if (
      !record ||
      record.id !== confirmed.confirmedWorkspaceId ||
      record.confirmationHash !== confirmed.confirmationHash
    )
      throw new WorkspaceReviewError('请确认当前清理记录。');
    if (record.state === 'completed') return record;
    if (!['completed', 'failed', 'cancelled'].includes(task.state))
      throw new WorkspaceReviewError('任务仍未结束。');
    await validateSource(source);
    if (await this.adapter.exists(record.plan))
      throw new WorkspaceReviewError('工作区目录仍存在，请人工核对；检查操作不会再次删除目录。');
    try {
      await this.adapter.finish(record.plan, source);
      return this.save({
        ...record,
        state: 'completed',
        failure: undefined,
        updatedAt: this.now(),
      });
    } catch {
      throw new WorkspaceReviewError('Git 登记或引用已变化，暂不能确认清理；记录与历史已保留。');
    }
  }
  private save(record: WorkspaceCleanup) {
    const parsed = WorkspaceCleanupSchema.parse(record);
    this.store.transaction(() => {
      this.store.save(parsed);
      this.store.audit(
        AuditEventSchema.parse({
          id: 'event-' + randomUUID(),
          projectId: record.projectId,
          taskId: record.taskId,
          type: 'workspace.cleanup.' + record.state,
          actor: { type: 'user', id: 'local-operator' },
          payload: {
            workspaceId: record.id,
            confirmationHash: record.confirmationHash,
            enforcementMode: 'enforced',
            boundary: 'control-plane-workspace',
          },
          occurredAt: this.now(),
        }),
      );
    });
    return parsed;
  }
}
