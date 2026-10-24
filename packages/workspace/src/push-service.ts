import { randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  WorkspacePushSchema,
  WorkspacePushInputSchema,
  ConfirmWorkspacePushSchema,
  type AuditEvent,
  type Workspace,
  type WorkspaceReview,
  type WorkspacePush,
  type Approval,
} from '@control-plane/core';
import { PolicyRequestSchema, type PolicyGate } from '@control-plane/policy';
import type { WorkspacePushAdapter } from './git-push.js';
import { WorkspaceReviewError } from './git-review.js';
export interface WorkspacePushStore {
  transaction<T>(operation: () => T): T;
  review(id: string): WorkspaceReview | undefined;
  workspace(id: string): Workspace | undefined;
  get(id: string): WorkspacePush | undefined;
  list(taskId: string): WorkspacePush[];
  save(push: WorkspacePush): WorkspacePush;
  audit(event: AuditEvent): void;
}
export class WorkspacePushService {
  constructor(
    private readonly store: WorkspacePushStore,
    private readonly adapter: WorkspacePushAdapter,
    private readonly policy: PolicyGate,
    private readonly now: () => string,
  ) {}
  list(taskId: string) {
    return this.store
      .list(taskId)
      .map((push) => ({ push, approvalState: this.policy.approvals.get(push.approvalId).state }));
  }
  canRestoreApproval(approval: Approval): boolean {
    if (
      approval.state !== 'pending' ||
      approval.acp ||
      approval.action !== 'git.push' ||
      approval.boundary !== 'control-plane-git' ||
      approval.enforcementMode !== 'enforced'
    )
      return false;
    const id = (approval.resource as { pushId?: unknown } | null)?.pushId;
    const push = typeof id === 'string' ? this.store.get(id) : undefined;
    return (
      !!push &&
      push.state === 'ready' &&
      push.approvalId === approval.id &&
      push.projectId === approval.projectId &&
      push.taskId === approval.taskId &&
      approval.assignmentId === undefined &&
      JSON.stringify(this.request(push).resource) === JSON.stringify(approval.resource)
    );
  }
  private review(taskId: string, reviewId: string) {
    const review = this.store.review(reviewId);
    if (!review || review.taskId !== taskId || review.state !== 'merged')
      throw new WorkspaceReviewError('请先完成此任务的本地审阅合并。');
    return review;
  }
  private source(id: string) {
    const source = this.store.workspace(id);
    if (!source) throw new WorkspaceReviewError('项目工作区已不可用。');
    return source;
  }
  private get(taskId: string, id: string) {
    const push = this.store.get(id);
    if (!push || push.taskId !== taskId) throw new WorkspaceReviewError('推送记录不属于当前任务。');
    return push;
  }
  remotes(taskId: string, reviewId: string) {
    return this.adapter.remotes(this.source(this.review(taskId, reviewId).sourceWorkspaceId));
  }
  async prepare(
    taskId: string,
    reviewId: string,
    raw: unknown,
    validate: (source: Workspace) => Promise<void>,
  ) {
    const input = WorkspacePushInputSchema.parse(raw),
      review = this.review(taskId, reviewId),
      source = this.source(review.sourceWorkspaceId);
    await validate(source);
    const destination = await this.adapter.destination(
      source,
      input.remote,
      review.targetBranch,
      review.mergeCommit,
    );
    await validate(source);
    return this.store.transaction(() => {
      const at = this.now(),
        base = {
          id: randomUUID(),
          reviewId,
          projectId: review.projectId,
          taskId: review.taskId,
          sourceWorkspaceId: source.id,
          remote: input.remote,
          ...destination,
          targetBranch: review.targetBranch,
          commit: review.mergeCommit,
          state: 'ready' as const,
          createdAt: at,
          updatedAt: at,
        };
      const request = this.request(base),
        decision = this.policy.engine.evaluate(request);
      if (decision.effect === 'deny')
        throw new WorkspaceReviewError('项目策略禁止推送；请先在项目策略中允许申请推送。');
      const approval = this.policy.approvals.request(request, { ...decision, effect: 'ask' });
      const saved = this.store.save(
        WorkspacePushSchema.parse({ ...base, approvalId: approval.id }),
      );
      this.audit(saved, 'prepared');
      return saved;
    });
  }
  decide(taskId: string, id: string, state: 'approved' | 'rejected') {
    const push = this.get(taskId, id);
    if (push.state !== 'ready') throw new WorkspaceReviewError('此推送已进入执行阶段。');
    if (state === 'approved' && this.policy.engine.evaluate(this.request(push)).effect === 'deny')
      throw new WorkspaceReviewError('项目策略已禁止推送。');
    return this.store.transaction(() => {
      const approval = this.policy.approvals.get(push.approvalId);
      if (approval.state !== 'pending' && approval.state !== state)
        throw new WorkspaceReviewError('此审批已结束，请重新申请。');
      this.policy.approvals.resolve(push.approvalId, state, 'local-operator');
      this.audit(push, state);
      return push;
    });
  }
  private authorized(push: WorkspacePush) {
    const request = this.request(push),
      approval = this.policy.approvals.get(push.approvalId);
    if (
      this.policy.engine.evaluate(request).effect === 'deny' ||
      approval.state !== 'approved' ||
      approval.projectId !== push.projectId ||
      approval.action !== 'git.push' ||
      JSON.stringify(approval.resource) !== JSON.stringify(request.resource)
    )
      throw new WorkspaceReviewError('此提交和推送地址尚未获准，或项目策略已禁止推送。');
  }
  async execute(
    taskId: string,
    id: string,
    raw: unknown,
    validate: (source: Workspace) => Promise<void>,
  ) {
    const push = this.get(taskId, id),
      confirmation = ConfirmWorkspacePushSchema.parse(raw);
    if (
      confirmation.confirmedCommit !== push.commit ||
      confirmation.confirmedDestinationHash !== push.destinationHash
    )
      throw new WorkspaceReviewError('确认内容与推送申请不一致。');
    if (push.state === 'pushed') return push;
    if (push.state !== 'ready')
      throw new WorkspaceReviewError('此前推送结果待核对，请核对远端结果；不会自动重新发送。');
    this.authorized(push);
    const source = this.source(push.sourceWorkspaceId);
    await validate(source);
    const target = await this.adapter.destination(
      source,
      push.remote,
      push.targetBranch,
      push.commit,
    );
    if (target.destinationHash !== push.destinationHash)
      throw new WorkspaceReviewError('远端地址已变化，请重新申请推送。');
    await validate(source);
    this.authorized(push);
    this.save(push, 'pushing', 'started');
    try {
      await this.adapter.push(source, push, target);
    } catch {
      return this.save(
        push,
        'failed',
        'failed',
        '推送未确认成功。请核对远端结果；若远端未更新，检查 Git 认证或分支冲突后重新申请。',
      );
    }
    return this.save(push, 'pushed', 'pushed');
  }
  async check(taskId: string, id: string, validate: (source: Workspace) => Promise<void>) {
    const push = this.get(taskId, id);
    if (push.state === 'pushed') return push;
    if (!['pushing', 'failed'].includes(push.state))
      throw new WorkspaceReviewError('尚未开始推送，无需核对。');
    const source = this.source(push.sourceWorkspaceId);
    await validate(source);
    const target = await this.adapter.destination(
      source,
      push.remote,
      push.targetBranch,
      push.commit,
    );
    if (target.destinationHash !== push.destinationHash)
      throw new WorkspaceReviewError('远端地址已变化，无法核对原推送目标。');
    if (await this.adapter.isPushed(source, push, target))
      return this.save(push, 'pushed', 'reconciled');
    return this.save(
      push,
      'failed',
      'checked',
      '远端分支当前未指向此提交。未重新发送；请检查远端历史后重新申请。',
    );
  }
  private save(
    push: WorkspacePush,
    state: WorkspacePush['state'],
    action: string,
    failure?: string,
  ) {
    return this.store.transaction(() => {
      const at = this.now(),
        saved = this.store.save({
          ...push,
          state,
          failure,
          updatedAt: at,
          ...(state === 'pushed' ? { pushedAt: at } : {}),
        });
      this.audit(saved, action);
      return saved;
    });
  }
  private request(
    push: Pick<
      WorkspacePush,
      | 'id'
      | 'projectId'
      | 'taskId'
      | 'sourceWorkspaceId'
      | 'destinationHash'
      | 'destination'
      | 'targetBranch'
      | 'commit'
    >,
  ) {
    return PolicyRequestSchema.parse({
      projectId: push.projectId,
      taskId: push.taskId,
      action: 'git.push',
      resource: {
        pushId: push.id,
        workspaceId: push.sourceWorkspaceId,
        destination: push.destination,
        destinationHash: push.destinationHash,
        targetBranch: push.targetBranch,
        commit: push.commit,
      },
      enforcementMode: 'enforced',
      boundary: 'control-plane-git',
    });
  }
  private audit(push: WorkspacePush, action: string) {
    this.store.audit(
      AuditEventSchema.parse({
        id: 'event-' + randomUUID(),
        projectId: push.projectId,
        taskId: push.taskId,
        type: 'workspace.push.' + action,
        actor: { type: 'user', id: 'local-operator' },
        occurredAt: this.now(),
        payload: {
          pushId: push.id,
          reviewId: push.reviewId,
          commit: push.commit,
          targetBranch: push.targetBranch,
          destination: push.destination,
          approvalId: push.approvalId,
          state: push.state,
          enforcementMode: 'enforced',
          boundary: 'control-plane-git',
        },
      }),
    );
  }
}
