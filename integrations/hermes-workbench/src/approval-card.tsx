import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SnapshotData } from './adapter';
import { PermissionEditPreview } from './permission-edit-preview';
import { approvalSummary } from './approval-summary';
import s from './approval-card.module.css';
type Approval = SnapshotData['approvals'][number];
type Props = {
  approval: Approval;
  taskTitle: string;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
};
export function ApprovalCard({ approval: a, taskTitle, busy, onDecide }: Props) {
  const summary = approvalSummary(a.resource);
  const stale =
    Date.now() > Date.parse(a.decisionEligibility.checkedAt) + a.decisionEligibility.validForMs;
  return (
    <article className={s.card} aria-label={`${summary.title} · ${taskTitle}`}>
      <header className={s.header}>
        <span className={s.badge}>需要你确认</span>
        <h3>{summary.title}</h3>
        <p>{taskTitle}</p>
      </header>
      <div className={s.body}>
        <p className={s.impact}>{summary.impact}</p>
        {a.acp?.review.action === 'process.execute' && (
          <>
            <div className={s.field}>
              <span>完整命令</span>
              <pre aria-label="完整命令">
                {summary.command ?? '未提供可核对的完整命令，请查看原始请求。'}
              </pre>
            </div>
            <div className={s.field}>
              <span>工作目录</span>
              <code aria-label="工作目录">{summary.directory ?? '未提供工作目录'}</code>
            </div>
          </>
        )}
        {a.acp?.review.action !== 'process.execute' && (
          <div className={s.field}>
            <span>操作目标</span>
            <code>{summary.target ?? a.acp?.review.target ?? '未提供'}</code>
          </div>
        )}
        <aside className={s.risk} aria-label="操作影响与风险">
          <strong>确认前请核对</strong>
          <p>{summary.risk}</p>
        </aside>
        <PermissionEditPreview resource={a.resource} />
        <details className={s.details}>
          <summary>请求详情与执行边界</summary>
          <dl>
            <dt>工具</dt>
            <dd>{a.acp?.review.tool ?? '未提供'}</dd>
            <dt>操作</dt>
            <dd>{a.acp?.review.action ?? a.action}</dd>
            <dt>执行边界</dt>
            <dd>
              {a.boundary ?? '未提供'} · {a.enforcementMode}
            </dd>
          </dl>
          <pre>{JSON.stringify(a.resource, null, 2)}</pre>
        </details>
      </div>
      <footer className={s.actions}>
        <div>
          <strong>仅允许这一次操作</strong>
          <span>
            {summary.expiresAt
              ? `请在 ${new Date(summary.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 前处理`
              : '后续请求仍按项目权限处理'}
          </span>
          {(!a.decisionEligibility.canApprove || stale) && (
            <span role="status">请求信息不完整、已失效或正在刷新，暂不能允许。</span>
          )}
        </div>
        <button
          type="button"
          disabled={busy || !a.decisionEligibility.canReject}
          onClick={() => onDecide(a.id, 'reject')}
        >
          拒绝
        </button>
        <button
          className={s.primary}
          type="button"
          disabled={busy || !a.decisionEligibility.canApprove || stale}
          onClick={() => onDecide(a.id, 'approve')}
        >
          允许本次
        </button>
      </footer>
    </article>
  );
}
export function ApprovalDialog({
  approval,
  onClose,
  error,
  ...props
}: Omit<Props, 'approval'> & { approval?: Approval; onClose: () => void; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="处理待确认操作"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={s.dialogHeader}>
        <div>
          <strong>操作确认</strong>
          <span>核对内容后，再决定是否继续</span>
        </div>
        <button type="button" aria-label="关闭操作确认" autoFocus onClick={onClose}>
          ×
        </button>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {approval?.state === 'pending' ? (
        <ApprovalCard approval={approval} {...props} />
      ) : (
        <div className={s.resolved} role="status">
          <h3>这项请求已更新</h3>
          <p>它已处理、过期或不再属于当前任务。请查看最新任务状态。</p>
          <button onClick={onClose}>返回任务</button>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
