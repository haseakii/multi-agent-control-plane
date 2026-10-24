import { useRef, useState } from 'react';
import type { WorkspaceCleanupPreview } from '../../../packages/core/src/workspace-cleanup';
import { api } from './http';

export function WorkspaceCleanupPanel({
  taskId,
  onSaved,
}: {
  taskId: string;
  onSaved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<WorkspaceCleanupPreview>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const path = '/api/tasks/' + encodeURIComponent(taskId) + '/workspace-cleanup';
  async function inspect() {
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      setPreview(await api<WorkspaceCleanupPreview>(path));
      if (!dialog.current?.open) dialog.current?.showModal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '检查失败。');
    } finally {
      setBusy(false);
    }
  }
  async function execute(recovery: boolean) {
    if (!preview || busy || (!recovery && (!confirmed || !preview.eligible))) return;
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      await api(path + (recovery ? '/check' : ''), {
        method: 'POST',
        body: JSON.stringify({
          confirmedWorkspaceId: preview.workspaceId,
          confirmationHash: recovery ? preview.record?.confirmationHash : preview.confirmationHash,
        }),
      });
      setPreview(await api<WorkspaceCleanupPreview>(path));
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成。');
      setPreview(await api<WorkspaceCleanupPreview>(path).catch(() => undefined));
    } finally {
      setBusy(false);
    }
  }
  const plan = preview?.plan ?? preview?.record?.plan;
  return (
    <section className="execution-context-panel" aria-label="工作区清理">
      <h3>任务工作区清理</h3>
      <p className="section-note">
        任务结束后检查可释放的目录和 Git 引用。任务、消息、审阅与产物历史继续保留。
      </p>
      <button ref={trigger} disabled={busy} onClick={() => void inspect()}>
        查看清理预览
      </button>
      {error && !dialog.current?.open ? <p role="alert">{error}</p> : null}
      <dialog
        ref={dialog}
        className="agent-removal-dialog"
        aria-label="确认清理任务工作区"
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <h3>清理任务工作区</h3>
        {preview ? (
          <>
            <p className="directory-path">目录：{preview.rootPath}</p>
            {preview.blockers.length ? (
              <ul>
                {preview.blockers.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {plan ? (
              <>
                <p>
                  任务分支：{plan.branch ?? '无'}（{plan.removeBranch ? '删除' : '保留或不适用'}）
                </p>
                <p>删除已合并的审阅引用：{plan.refs.length} 个</p>
                {plan.refs.length ? (
                  <ul>
                    {plan.refs.map((item) => (
                      <li key={item.name}>
                        <code>{item.name}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ul>
                  {plan.notes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {preview.eligible ? (
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我确认删除上述工作区和列出的 Git 引用，之后以新任务继续工作。
              </label>
            ) : null}
          </>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="memory-actions">
          <button disabled={busy} onClick={() => dialog.current?.close()}>
            关闭
          </button>
          <button disabled={busy} onClick={() => void inspect()}>
            重新检查
          </button>
          {preview?.record && preview.record.state !== 'completed' ? (
            <button disabled={busy} onClick={() => void execute(true)}>
              检查并收尾
            </button>
          ) : null}
          {preview?.eligible ? (
            <button disabled={busy || !confirmed} onClick={() => void execute(false)}>
              {busy ? '清理中…' : '确认清理'}
            </button>
          ) : null}
        </div>
      </dialog>
    </section>
  );
}
