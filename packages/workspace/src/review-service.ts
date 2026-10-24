import { randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  WorkspaceReviewSchema,
  MergeWorkspaceReviewSchema,
  type AuditEvent,
  type Task,
  type AssignmentWorkspace,
  type Workspace,
  type WorkspaceReview,
  type Artifact,
  type Approval,
} from '@control-plane/core';
import { PolicyRequestSchema, type PolicyGate } from '@control-plane/policy';
import { WorkspaceReviewError, type WorkspaceReviewAdapter } from './git-review.js';

export interface WorkspaceReviewStore {
  transaction<T>(operation: () => T): T;
  task(id: string): Task | undefined;
  bindings(taskId: string): AssignmentWorkspace[];
  workspace(id: string): Workspace | undefined;
  get(id: string): WorkspaceReview | undefined;
  list(taskId: string): WorkspaceReview[];
  save(review: WorkspaceReview): WorkspaceReview;
  audit(event: AuditEvent): void;
}
export interface ReviewArtifactPublisher {
  publish(input: {
    projectId: string;
    taskId: string;
    assignmentId: string;
    kind: 'diff' | 'json';
    content: string;
  }): Promise<Artifact>;
}

/** Approval binds immutable content and a target revision; execution remains a separate operator action. */
export class WorkspaceReviewService {
  constructor(
    private readonly store: WorkspaceReviewStore,
    private readonly adapter: WorkspaceReviewAdapter,
    private readonly publisher: ReviewArtifactPublisher,
    private readonly policy: PolicyGate,
    private readonly now: () => string,
  ) {}

  list(taskId: string) {
    return this.store.list(taskId);
  }
  approvalState(review: WorkspaceReview) {
    return this.policy.approvals.get(review.approvalId).state;
  }
  /** A fixed review survives restart; preserving it never grants permission to merge. */
  canRestoreApproval(approval: Approval): boolean {
    if (
      approval.state !== 'pending' ||
      approval.acp ||
      approval.action !== 'git.merge' ||
      approval.boundary !== 'control-plane-git' ||
      approval.enforcementMode !== 'enforced'
    )
      return false;
    const id = (approval.resource as { reviewId?: unknown } | null)?.reviewId;
    const review = typeof id === 'string' ? this.store.get(id) : undefined;
    return (
      !!review &&
      review.state === 'ready' &&
      review.approvalId === approval.id &&
      review.projectId === approval.projectId &&
      review.taskId === approval.taskId &&
      review.assignmentId === approval.assignmentId &&
      JSON.stringify(this.request(review).resource) === JSON.stringify(approval.resource)
    );
  }
  decide(taskId: string, reviewId: string, state: 'approved' | 'rejected') {
    const review = this.get(taskId, reviewId);
    if (review.state === 'merged' || review.state === 'applying')
      throw new WorkspaceReviewError('该审阅已进入合并阶段。');
    if (this.policy.engine.evaluate(this.request(review)).effect === 'deny')
      throw new WorkspaceReviewError('策略已拒绝此操作。');
    return this.store.transaction(() => {
      const approval = this.policy.approvals.get(review.approvalId);
      if (approval.state !== 'pending' && approval.state !== state)
        throw new WorkspaceReviewError('该审批已结束，请生成新的审阅。');
      this.policy.approvals.resolve(review.approvalId, state, 'local-operator');
      this.audit(review, state);
      return review;
    });
  }
  get(taskId: string, reviewId: string) {
    const review = this.store.get(reviewId);
    if (!review || review.taskId !== taskId)
      throw new WorkspaceReviewError('审阅记录不属于当前任务。');
    return review;
  }
  async prepare(
    taskId: string,
    validate: (workspace: Workspace, source: Workspace) => Promise<void>,
  ) {
    const task = this.store.task(taskId);
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.state))
      throw new WorkspaceReviewError('请等待任务结束后生成变更审阅。');
    const binding = this.store.bindings(taskId).at(-1);
    const workspace = binding && this.store.workspace(binding.workspaceId),
      source = binding && this.store.workspace(binding.sourceWorkspaceId);
    if (!binding || binding.mode !== 'git-worktree' || !workspace || !source)
      throw new WorkspaceReviewError('此任务没有可审阅的独立 Git 工作区。');
    await validate(workspace, source);
    const id = randomUUID(),
      prepared = await this.adapter.prepare(workspace, source, id);
    const patch = await this.publisher.publish({
      projectId: task.projectId,
      taskId,
      assignmentId: binding.id,
      kind: 'diff',
      content: prepared.patch,
    });
    const { patch: _patch, ...manifest } = prepared;
    const metadata = await this.publisher.publish({
      projectId: task.projectId,
      taskId,
      assignmentId: binding.id,
      kind: 'json',
      content: JSON.stringify({ reviewId: id, ...manifest }, null, 2),
    });
    await validate(workspace, source);
    return this.store.transaction(() => {
      const at = this.now();
      const base = {
        id,
        projectId: task.projectId,
        taskId: task.id,
        assignmentId: binding.id,
        workspaceId: workspace.id,
        sourceWorkspaceId: source.id,
        ...manifest,
        patchArtifactId: patch.id,
        manifestArtifactId: metadata.id,
        state: 'ready' as const,
        createdAt: at,
        updatedAt: at,
      };
      const authorization = this.policy.authorize(this.request(base));
      // V0 merge always needs a concrete human decision even if a broader rule allows Git operations.
      const approval =
        authorization.status === 'approval_required'
          ? authorization.approval
          : this.policy.approvals.request(PolicyRequestSchema.parse(this.request(base)), {
              ...authorization.decision,
              effect: 'ask',
              ruleId: 'workspace-review-human-approval',
            });
      const review = this.store.save(
        WorkspaceReviewSchema.parse({ ...base, approvalId: approval.id }),
      );
      for (const previous of this.store.list(taskId))
        if (previous.id !== id && previous.state === 'ready')
          this.policy.approvals.expire(previous.approvalId, 'superseded-workspace-review');
      this.audit(review, 'prepared');
      return review;
    });
  }
  async merge(
    taskId: string,
    reviewId: string,
    raw: unknown,
    validate: (workspace: Workspace, source: Workspace) => Promise<void>,
  ) {
    let review = this.get(taskId, reviewId);
    const confirmation = MergeWorkspaceReviewSchema.parse(raw);
    if (
      confirmation.confirmedTargetBranch !== review.targetBranch ||
      confirmation.confirmedMergeCommit !== review.mergeCommit
    )
      throw new WorkspaceReviewError('合并确认与当前审阅快照不一致。');
    if (review.state === 'merged') return review;
    const workspace = this.store.workspace(review.workspaceId),
      source = this.store.workspace(review.sourceWorkspaceId);
    if (!workspace || !source) throw new WorkspaceReviewError('审阅工作区已不可用。');
    await validate(workspace, source);
    const request = this.request(review),
      decision = this.policy.engine.evaluate(request);
    const approval = this.policy.approvals.get(review.approvalId);
    if (
      decision.effect === 'deny' ||
      approval.state !== 'approved' ||
      approval.projectId !== review.projectId ||
      approval.action !== 'git.merge' ||
      JSON.stringify(approval.resource) !== JSON.stringify(request.resource)
    )
      throw new WorkspaceReviewError('此具体快照尚未获准合并，或策略已拒绝该操作。');
    if (
      (review.state === 'applying' || review.state === 'failed') &&
      (await this.adapter.isApplied(review, source))
    )
      return this.merged(review);
    review = this.store.transaction(() => {
      const applying = this.store.save({
        ...review,
        state: 'applying',
        failure: undefined,
        updatedAt: this.now(),
      });
      this.audit(applying, 'merge-started');
      return applying;
    });
    try {
      await this.adapter.apply(review, source);
    } catch (error) {
      const message =
        error instanceof WorkspaceReviewError
          ? error.message
          : 'Git 合并未完成；请检查目标目录后重试或重新生成审阅。';
      this.store.transaction(() => {
        const failed = this.store.save({
          ...review,
          state: 'failed',
          failure: message,
          updatedAt: this.now(),
        });
        this.audit(failed, 'merge-failed');
      });
      throw new WorkspaceReviewError(message);
    }
    return this.merged(review);
  }
  private merged(review: WorkspaceReview) {
    return this.store.transaction(() => {
      const at = this.now(),
        saved = this.store.save({ ...review, state: 'merged', mergedAt: at, updatedAt: at });
      this.audit(saved, 'merged');
      return saved;
    });
  }
  private request(
    review: Pick<
      WorkspaceReview,
      | 'id'
      | 'projectId'
      | 'taskId'
      | 'assignmentId'
      | 'workspaceId'
      | 'sourceWorkspaceId'
      | 'mergeCommit'
      | 'targetHead'
      | 'targetBranch'
      | 'patchArtifactId'
    >,
  ) {
    return PolicyRequestSchema.parse({
      projectId: review.projectId,
      taskId: review.taskId,
      assignmentId: review.assignmentId,
      action: 'git.merge',
      resource: {
        reviewId: review.id,
        workspaceId: review.workspaceId,
        targetWorkspaceId: review.sourceWorkspaceId,
        mergeCommit: review.mergeCommit,
        targetHead: review.targetHead,
        targetBranch: review.targetBranch,
        patchArtifactId: review.patchArtifactId,
      },
      enforcementMode: 'enforced',
      boundary: 'control-plane-git',
    });
  }
  private audit(review: WorkspaceReview, action: string) {
    this.store.audit(
      AuditEventSchema.parse({
        id: 'event-' + randomUUID(),
        projectId: review.projectId,
        taskId: review.taskId,
        assignmentId: review.assignmentId,
        type: 'workspace.review.' + action,
        actor: { type: 'user', id: 'local-operator' },
        occurredAt: this.now(),
        payload: {
          reviewId: review.id,
          mergeCommit: review.mergeCommit,
          targetBranch: review.targetBranch,
          approvalId: review.approvalId,
          enforcementMode: 'enforced',
          boundary: 'control-plane-git',
          ...(review.failure ? { failure: review.failure } : {}),
        },
      }),
    );
  }
}
