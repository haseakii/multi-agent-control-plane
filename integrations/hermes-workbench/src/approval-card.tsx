import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, Terminal, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { SnapshotData } from './adapter';
import { PermissionEditPreview } from './permission-edit-preview';
import { approvalOutcome, approvalSummary } from './approval-summary';
import s from './approval-card.module.css';
type Approval = SnapshotData['approvals'][number];
type Props = {
  approval: Approval;
  taskTitle: string;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
};

export type InlineApprovalProps = Props & {
  onTrustRule?: (approval: Approval) => Promise<void> | void;
};

export function InlineApprovalCard({
  approval: a,
  taskTitle,
  busy,
  onDecide,
  onTrustRule,
}: InlineApprovalProps) {
  const [trustSimilar, setTrustSimilar] = useState(false);
  const summary = approvalSummary(a.resource);
  const pending = a.state === 'pending';
  const outcome = approvalOutcome(a.state);
  const stale =
    Date.now() > Date.parse(a.decisionEligibility.checkedAt) + a.decisionEligibility.validForMs;

  const handleApprove = async () => {
    if (trustSimilar && onTrustRule) {
      await onTrustRule(a);
    }
    onDecide(a.id, 'approve');
  };

  if (!pending) {
    return (
      <div className={s.inlineCardResolved} role="status">
        <ShieldCheck size={15} className={s.resolvedIcon} />
        <span>
          {outcome.title}：{outcome.message}
        </span>
      </div>
    );
  }

  return (
    <div className={s.inlineCard} role="alert" aria-label={`操作确认：${summary.title}`}>
      <div className={s.inlineHeader}>
        <div className={s.inlineTitleRow}>
          <ShieldAlert size={16} className={s.inlineAlertIcon} />
          <strong>操作确认请求</strong>
          <span className={s.inlineSubtitle}>{summary.title}</span>
        </div>
        {summary.expiresAt && (
          <span className={s.expireTag}>
            请在 {new Date(summary.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 前处理
          </span>
        )}
      </div>

      <div className={s.inlineBody}>
        {a.acp?.review.action === 'process.execute' ? (
          <div className={s.commandBox}>
            <div className={s.commandHeader}>
              <Terminal size={13} />
              <span>请求执行命令</span>
            </div>
            <code>{summary.command ?? '未提供完整命令'}</code>
            {summary.directory && (
              <small className={s.directoryHint}>工作目录：{summary.directory}</small>
            )}
          </div>
        ) : (
          <div className={s.targetBox}>
            <span className={s.targetLabel}>操作目标：</span>
            <code>{summary.target ?? a.acp?.review.target ?? '文件或资源操作'}</code>
          </div>
        )}

        {summary.risk && (
          <div className={s.inlineRisk}>
            <AlertTriangle size={13} className={s.riskIcon} />
            <span>{summary.risk}</span>
          </div>
        )}

        <PermissionEditPreview resource={a.resource} />

        <details className={s.inlineDetails}>
          <summary>技术参数与执行边界</summary>
          <dl>
            <dt>工具</dt>
            <dd>{a.acp?.review.tool ?? '未提供'}</dd>
            <dt>操作</dt>
            <dd>{a.acp?.review.action ?? a.action}</dd>
            <dt>边界</dt>
            <dd>
              {a.boundary ?? '未提供'} · {a.enforcementMode}
            </dd>
          </dl>
          <pre>{JSON.stringify(a.resource, null, 2)}</pre>
        </details>
      </div>

      <div className={s.inlineFooter}>
        <label className={s.trustCheckbox}>
          <input
            type="checkbox"
            checked={trustSimilar}
            onChange={(e) => setTrustSimilar(e.target.checked)}
          />
          <span>本任务内自动批准同类操作（保留审计记录）</span>
        </label>
        <div className={s.buttonGroup}>
          <button
            type="button"
            className={s.rejectBtn}
            disabled={busy || !a.decisionEligibility.canReject}
            onClick={() => onDecide(a.id, 'reject')}
          >
            拒绝
          </button>
          <button
            type="button"
            className={s.approveBtn}
            disabled={busy || !a.decisionEligibility.canApprove || stale}
            onClick={() => void handleApprove()}
          >
            允许本次
          </button>
        </div>
      </div>
    </div>
  );
}
export function ApprovalCard({ approval: a, taskTitle, busy, onDecide }: Props) {
  const summary = approvalSummary(a.resource);
  const pending = a.state === 'pending';
  const outcome = approvalOutcome(a.state);
  const stale =
    Date.now() > Date.parse(a.decisionEligibility.checkedAt) + a.decisionEligibility.validForMs;
  return (
    <article className={s.card} aria-label={`${summary.title} · ${taskTitle}`}>
      <header className={s.header}>
        <span className={s.badge}>{pending ? '需要你确认' : outcome.title}</span>
        <h3>{summary.title}</h3>
        <p>{taskTitle}</p>
      </header>
      <div className={s.body}>
        <p className={s.impact}>{pending ? summary.impact : outcome.message}</p>
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
          <strong>{pending ? '确认前请核对' : '操作影响与风险'}</strong>
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
        {pending ? (
          <>
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
          </>
        ) : (
          <div role="status">
            <strong>{outcome.title}</strong>
            {summary.expiresAt && (
              <span>
                请求截止：{new Date(summary.expiresAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            )}
            <span>历史请求仅供查看，不能再次批准。需要补做时请在原会话说明。</span>
          </div>
        )}
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
  const pending = approval?.state === 'pending';
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
      aria-label={pending ? '处理待确认操作' : '查看操作记录'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={s.dialogHeader}>
        <div>
          <strong>{pending ? '操作确认' : '操作记录'}</strong>
          <span>{pending ? '核对内容后，再决定是否继续' : '查看已关闭请求的内容与原因'}</span>
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
      {approval ? (
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
