import { useEffect, useState } from 'react';
import type { WorkspaceReview } from '../../../packages/core/src/workspace-review';
import type { WorkspacePush } from '../../../packages/core/src/workspace-push';
import { api } from './http';
type Row = { push: WorkspacePush; approvalState: string };
export function WorkspacePushPanel({
  review,
  active,
  onSaved,
}: {
  review: WorkspaceReview;
  active: boolean;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [remotes, setRemotes] = useState<string[]>([]),
    [remote, setRemote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const taskPath = '/api/tasks/' + encodeURIComponent(review.taskId),
    reviewPath = taskPath + '/workspace-reviews/' + review.id;
  async function refresh() {
    const [saved, names] = await Promise.all([
      api<Row[]>(taskPath + '/workspace-pushes'),
      api<string[]>(reviewPath + '/push-remotes'),
    ]);
    setRows(saved.filter((row) => row.push.reviewId === review.id));
    setRemotes(names);
    setRemote((current) =>
      names.includes(current) ? current : names.includes('origin') ? 'origin' : (names[0] ?? ''),
    );
  }
  useEffect(() => {
    void refresh().catch(() => setError('推送记录或远端配置加载失败。'));
  }, [review.id]);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await refresh();
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败。');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  const current = rows.at(-1),
    push = current?.push;
  return (
    <section aria-label="推送已审阅提交">
      <h4>推送已审阅提交</h4>
      <p className="section-note">
        将已合并的固定提交及其祖先历史发送到所选远端分支。后来产生的提交不会加入本次推送；不会强制覆盖远端，也不推送标签。Git
        认证沿用本机配置。
      </p>
      <label>
        推送远端{' '}
        <select
          aria-label="推送远端"
          value={remote}
          disabled={busy}
          onChange={(event) => setRemote(event.target.value)}
        >
          {remotes.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {!remotes.length ? <p>项目仓库尚无可用远端，请先通过 Git 配置。</p> : null}
      <div className="memory-actions">
        <button
          disabled={busy || active || !remote}
          onClick={() => void action(reviewPath + '/pushes', { remote })}
        >
          生成推送申请
        </button>
        <button disabled={busy} onClick={() => void refresh().catch(() => setError('加载失败。'))}>
          刷新推送记录
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {push && current ? (
        <>
          <p>
            目标：
            <strong>
              {push.remote} / {push.targetBranch}
            </strong>
          </p>
          <p className="directory-path">地址：{push.destination}</p>
          <p className="directory-path">提交：{push.commit}</p>
          <p role="status">
            {push.state === 'pushed'
              ? '已推送'
              : push.state === 'pushing'
                ? '推送中或结果待核对'
                : push.state === 'failed'
                  ? '结果未确认'
                  : current.approvalState === 'approved'
                    ? '已批准，等待单独执行'
                    : current.approvalState === 'pending'
                      ? '等待人工审批'
                      : '审批已结束'}
          </p>
          {push.failure ? <p role="alert">{push.failure}</p> : null}
          {push.state === 'ready' && current.approvalState === 'pending' ? (
            <div className="memory-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void action(taskPath + '/workspace-pushes/' + push.id + '/decision', {
                    state: 'approved',
                  })
                }
              >
                批准此推送目标
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void action(taskPath + '/workspace-pushes/' + push.id + '/decision', {
                    state: 'rejected',
                  })
                }
              >
                拒绝推送
              </button>
            </div>
          ) : null}
          {push.state === 'ready' && current.approvalState === 'approved' ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我确认把上述提交及祖先历史发送到此地址的 {push.targetBranch} 分支
              </label>
              <button
                disabled={busy || active || !confirmed}
                onClick={() =>
                  void action(taskPath + '/workspace-pushes/' + push.id + '/execute', {
                    confirmedCommit: push.commit,
                    confirmedDestinationHash: push.destinationHash,
                  })
                }
              >
                确认推送
              </button>
            </>
          ) : null}
          {['pushing', 'failed'].includes(push.state) ? (
            <button
              disabled={busy || active}
              onClick={() => void action(taskPath + '/workspace-pushes/' + push.id + '/check', {})}
            >
              核对远端结果（不重新发送）
            </button>
          ) : null}
          <details>
            <summary>历史推送申请（{rows.length}）</summary>
            {rows.map(({ push: item, approvalState }) => (
              <p key={item.id}>
                {new Date(item.createdAt).toLocaleString()} · {item.remote}/{item.targetBranch} ·{' '}
                {item.state} · {approvalState}
                <br />
                {item.destination}
              </p>
            ))}
          </details>
        </>
      ) : null}
    </section>
  );
}
