import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Snapshot } from './view-model';
import { approvalStateLabel } from './presentation';
import { HttpError } from './http';

export type ApprovalItem = Snapshot['approvals'][number];
const eligibilityLabels: Record<string, string> = {
  current_complete: '服务端已确认：当前请求信息完整，可作单次决定。',
  details_missing: '权限信息缺失，不能批准。',
  details_truncated: '权限摘要已截断，不能批准。',
  details_redacted: '敏感内容已隐藏，授权信息不完整，不能批准。',
  details_invalid: '协议字段无效或被过滤，不能批准。',
  history_expired: '关联的历史工具信息已过期，不能批准。',
  deadline_expired: '权限请求已超过有效时间。',
  legacy_binding_missing: '历史记录缺少执行身份绑定，不可操作。',
  execution_changed: '执行、会话或请求归属已变化，不可操作。',
  approval_expired: '此审批已失效，不可操作。',
  already_decided: '此审批已决定，不可再次操作。',
  unsupported_boundary: '此记录不支持在此授予单次 ACP 许可。',
  runtime_unavailable: '服务端尚未提供当前执行资格，操作不可用。',
};
const reviewLabels: Record<string, string> = {
  missing_tool: '未提供工具',
  missing_action: '未提供动作',
  missing_target: '未提供目标',
  sdk_filtered: 'SDK 过滤或丢弃了协议字段',
  wire_unavailable: '接收结构不可核对',
  truncated: '摘要超过边界，内容已截断',
  history_expired: '历史关联已过期',
  invalid_identity: '请求身份无效',
  sensitive_redacted: '存在敏感内容，已隐藏',
};
const sourceLabels = {
  request: '当前权限请求',
  history: '同会话、同工具调用的先前事件',
  unknown: '未提供',
};

export function getApprovalRiskLevel(
  tool?: string | null,
  action?: string | null,
): { level: 'danger' | 'warning' | 'info'; label: string } {
  const text = `${tool ?? ''} ${action ?? ''}`.toLowerCase();
  if (
    /terminal|bash|shell|exec|run_command|command|cmd|powershell|delete|destroy|reset|force|push/.test(
      text,
    )
  ) {
    return { level: 'danger', label: '高危操作' };
  }
  if (/write|edit|modify|patch|save|update|create|merge/.test(text)) {
    return { level: 'warning', label: '变更写入' };
  }
  return { level: 'info', label: '只读/常规' };
}
export function approvalAvailability(
  approval: ApprovalItem,
  healthy: boolean,
  startedAt: number,
  now: number,
  busy: boolean,
  refreshing = false,
  present = true,
) {
  const eligibility = approval.decisionEligibility;
  let reason = !eligibility
    ? '服务端未提供可操作资格。'
    : (eligibilityLabels[eligibility.reason] ?? '资格原因无法识别，操作不可用。');
  let usable = Boolean(
    eligibility &&
      approval.state === 'pending' &&
      (eligibility.canApprove || eligibility.canReject),
  );
  if (!present) {
    usable = false;
    reason = '当前快照不再包含此记录，操作不可用。';
  } else if (!healthy) {
    usable = false;
    reason = '服务端快照刷新失败，无法确认当前资格。';
  } else if (usable && (refreshing || now - startedAt >= eligibility!.validForMs)) {
    usable = false;
    reason = '正在等待最新服务端资格，操作暂不可用。';
  } else if (usable && busy) {
    usable = false;
    reason = '正在保存或处理另一项操作，请等待结果。';
  }
  return {
    canApprove: usable && eligibility?.canApprove === true,
    canReject: usable && eligibility?.canReject === true,
    reason,
  };
}
type Availability = ReturnType<typeof approvalAvailability>;
type Operation = {
  id: string;
  status: 'saving' | 'confirmed' | 'failed';
  decision: 'approve' | 'reject';
  message: string;
};
export function approvalDecisionError(error: unknown): string {
  return error instanceof HttpError
    ? error.status === 409
      ? `决定未保存（HTTP 409）：${error.message} 请以最新状态为准。`
      : `决定未确认（HTTP ${error.status}）：${error.message}`
    : '决定未确认，请检查连接并刷新状态。';
}
export function ApprovalReview({
  approval,
  availability,
  operation,
  onClose,
  onDecision,
  headingRef,
}: {
  approval: ApprovalItem;
  availability: Availability;
  operation?: Operation | undefined;
  onClose: () => void;
  onDecision: (decision: 'approve' | 'reject') => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const review = approval.acp?.review;
  const risk = getApprovalRiskLevel(review?.tool ?? approval.action, review?.action);
  return (
    <section
      className="approval-review"
      aria-label="审批详情"
      aria-busy={operation?.status === 'saving'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="task-heading">
        <h3 tabIndex={-1} ref={headingRef}>
          审批详情
        </h3>
        <button type="button" onClick={onClose}>
          返回审批列表
        </button>
      </div>
      <p>
        <span className={`risk-badge risk-${risk.level}`}>{risk.label}</span>{' '}
        {approvalStateLabel(approval.state)} ·{' '}
        {approval.enforcementMode === 'cooperative' ? '协作式执行边界' : approval.enforcementMode}
      </p>
      <dl className="approval-facts">
        <dt>工具</dt>
        <dd>{review?.tool ?? '未知'}</dd>
        <dt>动作</dt>
        <dd>{review?.action ?? '未知'}</dd>
        <dt>目标</dt>
        <dd>{review?.target ?? '未知'}</dd>
      </dl>
      <p className="approval-note" id="approval-eligibility-reason">
        {availability.reason}
      </p>
      {review?.reasons.length ? (
        <p className="approval-note">
          {review.reasons.map((reason) => reviewLabels[reason] ?? '未识别原因').join('；')}。
        </p>
      ) : null}
      <h4>安全参数摘要</h4>
      <pre className="approval-resource" tabIndex={0} aria-label="安全参数摘要">
        {JSON.stringify(review?.parameters ?? '未提供', null, 2)}
      </pre>
      <h4>协议字段来源</h4>
      <dl className="approval-facts">
        {(['rawInput', 'locations', 'content'] as const).map((field) => (
          <div key={field}>
            <dt>{{ rawInput: '参数', locations: '位置', content: '内容' }[field]}</dt>
            <dd>{sourceLabels[review?.provenance[field] ?? 'unknown']}</dd>
          </div>
        ))}
      </dl>
      <details className="technical-details">
        <summary>执行绑定详情</summary>
        <dl>
          <dt>审批 ID</dt>
          <dd>{approval.id}</dd>
          <dt>任务 ID</dt>
          <dd>{approval.taskId ?? '未关联'}</dd>
          <dt>执行 attempt</dt>
          <dd>
            {approval.acp ? `${approval.acp.attemptNumber} · ${approval.acp.attemptId}` : '未提供'}
          </dd>
          <dt>权限截止时间</dt>
          <dd>{approval.acp?.expiresAt ?? '未提供'}</dd>
        </dl>
      </details>
      <p className="approval-note">
        决定仅针对当前请求。代理工具的后续执行仍需查看任务结果；此处不提供操作系统沙箱保证。返回列表不会作出决定。
      </p>
      {operation ? (
        <p
          role={operation.status === 'failed' ? 'alert' : 'status'}
          className={operation.status === 'failed' ? 'inline-error' : 'approval-note'}
        >
          {operation.message}
        </p>
      ) : null}
      <div className="card-actions">
        <button
          type="button"
          className="reject-button"
          disabled={!availability.canReject}
          aria-describedby="approval-eligibility-reason"
          onClick={() => onDecision('reject')}
        >
          拒绝当前请求
        </button>
        {approval.decisionEligibility?.canApprove ? (
          <button
            type="button"
            disabled={!availability.canApprove}
            aria-describedby="approval-eligibility-reason"
            onClick={() => onDecision('approve')}
          >
            允许一次
          </button>
        ) : null}
      </div>
    </section>
  );
}
export function ApprovalPanel({
  approvals,
  visibleIds,
  diagnostics,
  healthy,
  startedAt,
  busy,
  onRefresh,
  onDecision,
}: {
  approvals: ApprovalItem[];
  visibleIds: string[];
  diagnostics: Snapshot['approvalReadDiagnostics'];
  healthy: boolean;
  startedAt: number;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onDecision: (id: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  type Selection = { id: string; generation: number };
  const [selected, setSelected] = useState<Selection | null>(null),
    [operation, setOperation] = useState<Operation>(),
    [refreshGeneration, setRefreshGeneration] = useState<number | null>(null),
    [clock, setClock] = useState(() => performance.now());
  const pending = useRef(false),
    generation = useRef(0),
    heading = useRef<HTMLHeadingElement>(null),
    listHeading = useRef<HTMLHeadingElement>(null);
  const current =
    selected && visibleIds.includes(selected.id)
      ? approvals.find((item) => item.id === selected.id)
      : undefined;
  // Event handlers may outlive a render. Read the current scope and selection again
  // at submission/settlement rather than trusting their captured render values.
  const live = useRef({
    selection: selected,
    approvals,
    visibleIds,
    healthy,
    startedAt,
    busy,
    refreshGeneration,
    onDecision,
  });
  live.current = {
    selection: current ? selected : null,
    approvals,
    visibleIds,
    healthy,
    startedAt,
    busy,
    refreshGeneration,
    onDecision,
  };
  const refreshing = selected !== null && refreshGeneration === selected.generation;
  useEffect(
    () => () => {
      live.current.selection = null;
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (selected && !current) {
      setSelected((value) => (value === selected ? null : value));
      setRefreshGeneration((value) => (value === selected.generation ? null : value));
    }
  }, [selected, current]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(performance.now()), 200);
    const refresh = () => {
      void onRefresh();
    };
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [onRefresh]);
  useEffect(() => {
    if (selected) heading.current?.focus({ preventScroll: true });
  }, [selected]);
  const close = () => {
    if (!selected || live.current.selection !== selected) return;
    const { id } = selected;
    live.current.selection = null;
    const closedGeneration = ++generation.current;
    setSelected(null);
    setRefreshGeneration(null);
    requestAnimationFrame(() => {
      if (generation.current !== closedGeneration || live.current.selection) return;
      const trigger = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-approval-trigger]'),
      ).find((item) => item.dataset.approvalTrigger === id);
      (trigger ?? listHeading.current)?.focus({ preventScroll: true });
    });
  };
  const decide = async (decision: 'approve' | 'reject') => {
    const latest = live.current;
    if (
      !selected ||
      latest.selection !== selected ||
      pending.current ||
      !latest.visibleIds.includes(selected.id)
    )
      return;
    const review = latest.approvals.find((item) => item.id === selected.id);
    if (!review) return;
    const available = approvalAvailability(
      review,
      latest.healthy,
      latest.startedAt,
      performance.now(),
      latest.busy,
      latest.refreshGeneration === selected.generation,
      true,
    );
    if (!(decision === 'approve' ? available.canApprove : available.canReject)) return;
    pending.current = true;
    const id = review.id;
    setOperation({ id, status: 'saving', decision, message: '正在保存决定，请勿重复提交。' });
    try {
      await latest.onDecision(id, decision);
      setOperation({
        id,
        status: 'confirmed',
        decision,
        message:
          decision === 'approve'
            ? '服务端已确认此审批为允许一次。请查看后续任务结果。'
            : '服务端已确认拒绝此请求。',
      });
    } catch (error) {
      setOperation({ id, status: 'failed', decision, message: approvalDecisionError(error) });
      await onRefresh();
    } finally {
      pending.current = false;
    }
  };
  return (
    <section className="context-section" aria-label="Approvals">
      <h2 ref={listHeading} tabIndex={-1}>
        审批决定
      </h2>
      {diagnostics && diagnostics.count > 0 ? (
        <p className="approval-isolation" role="status">
          控制面已隔离 {diagnostics.count} 条敏感历史审批，仅提供计数，不提供原文或操作。
          <small>APPROVAL_SENSITIVE_RECORDS_ISOLATED</small>
        </p>
      ) : null}
      {selected && current ? (
        <ApprovalReview
          approval={current}
          availability={approvalAvailability(
            current,
            healthy,
            startedAt,
            clock,
            busy || pending.current,
            refreshing,
            Boolean(current),
          )}
          operation={operation?.id === current.id ? operation : undefined}
          onClose={close}
          onDecision={(decision) => {
            void decide(decision);
          }}
          headingRef={heading}
        />
      ) : (
        <div className="stack">
          {approvals
            .filter((item) => visibleIds.includes(item.id))
            .map((approval) => {
              const risk = getApprovalRiskLevel(
                approval.acp?.review.tool ?? approval.action,
                approval.acp?.review.action,
              );
              return (
                <article className="approval-card" data-state={approval.state} key={approval.id}>
                  <div className="task-heading">
                    <strong>{approval.acp?.review.tool ?? approval.action}</strong>
                    <div className="card-badge-group">
                      <span className={`risk-badge risk-${risk.level}`}>{risk.label}</span>
                      <span className="badge">{approvalStateLabel(approval.state)}</span>
                    </div>
                  </div>
                  <p className="approval-note">
                    {approval.action === 'git.push' &&
                    approval.boundary === 'control-plane-git' &&
                    approval.state === 'pending'
                      ? '请在任务的“推送已审阅提交”面板查看提交和远端地址后批准。'
                      : approval.action === 'git.merge' &&
                          approval.boundary === 'control-plane-git' &&
                          approval.state === 'pending'
                        ? '请在任务的“变更审阅与本地合并”面板查看快照并批准。'
                        : approval.decisionEligibility
                          ? eligibilityLabels[approval.decisionEligibility.reason]
                          : '服务端资格未提供，操作不可用。'}
                  </p>
                  {operation?.id === approval.id ? (
                    <p role={operation.status === 'failed' ? 'alert' : 'status'}>
                      {operation.message}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    data-approval-trigger={approval.id}
                    onClick={() => {
                      if (!live.current.visibleIds.includes(approval.id)) return;
                      const selection = { id: approval.id, generation: ++generation.current };
                      live.current.selection = selection;
                      setSelected(selection);
                      setRefreshGeneration(selection.generation);
                      const settled = () => {
                        if (live.current.selection === selection) {
                          setRefreshGeneration((value) =>
                            value === selection.generation ? null : value,
                          );
                        }
                      };
                      void onRefresh().then(settled, settled);
                    }}
                  >
                    查看审批详情
                  </button>
                </article>
              );
            })}
          {!approvals.some((item) => visibleIds.includes(item.id)) ? (
            <p className="empty">当前任务范围没有可显示的审批记录。</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
