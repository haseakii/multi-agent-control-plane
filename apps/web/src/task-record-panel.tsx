import { useRef, useState } from 'react';
import type { TaskRecordView } from '../../../packages/core/src/task-record';
import type { Task } from './view-model';
import { api } from './http';
import { DirectoryExecutionNotice } from './existing-directory-input';

export function TaskRecordPanel({
  task,
  boss,
  directory,
  onSaved,
  onDeleted,
}: {
  task: Task;
  boss?: { id: string; name: string } | undefined;
  directory?: { workspaceId: string; rootPath: string; version: string } | undefined;
  onSaved: () => Promise<unknown>;
  onDeleted: () => void;
}) {
  const [mode, setMode] = useState<'edit' | 'delete' | 'start'>('edit');
  const [view, setView] = useState<TaskRecordView>();
  const [title, setTitle] = useState(''),
    [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const path = '/api/tasks/' + encodeURIComponent(task.id);
  async function inspect(choice: typeof mode, button: HTMLButtonElement) {
    if (busy) return;
    trigger.current = button;
    setBusy(true);
    setError('');
    setAccepted(false);
    try {
      const current = await api<TaskRecordView>(path + '/record');
      setView(current);
      setTitle(current.task.title);
      setObjective(current.task.objective);
      setMode(choice);
      dialog.current?.showModal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取失败。');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!view || busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'edit')
        await api(path, {
          method: 'PATCH',
          body: JSON.stringify({
            version: view.version,
            title: title.trim(),
            ...(view.canEditObjective ? { objective: objective.trim() } : {}),
          }),
        });
      else if (mode === 'delete')
        await api(path, { method: 'DELETE', body: JSON.stringify({ version: view.version }) });
      else
        await api(path + '/start', {
          method: 'POST',
          body: JSON.stringify({
            version: view.version,
            bossAgentId: boss?.id,
            ...(directory ? { workspaceConfirmation: directory } : {}),
          }),
        });
      dialog.current?.close();
      if (mode === 'delete') onDeleted();
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，内容已保留。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="task-record-actions">
      <div className="form-actions">
        <button disabled={busy} onClick={(event) => void inspect('edit', event.currentTarget)}>
          {task.state === 'draft' ? '编辑草稿' : '修改标题'}
        </button>
        {task.state === 'draft' && !task.parentTaskId ? (
          <>
            <button
              disabled={busy || !boss}
              onClick={(event) => void inspect('start', event.currentTarget)}
            >
              启动任务
            </button>
            <button
              disabled={busy}
              onClick={(event) => void inspect('delete', event.currentTarget)}
            >
              删除草稿
            </button>
            {!boss ? <small>选择 Boss 后即可启动；草稿已经保存。</small> : null}
          </>
        ) : null}
      </div>
      {error && !dialog.current?.open ? <p role="alert">{error}</p> : null}
      <dialog
        ref={dialog}
        className="task-action-dialog"
        aria-label="任务管理"
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <h2>
          {mode === 'edit' ? '编辑任务' : mode === 'delete' ? '确认删除草稿' : '确认启动任务'}
        </h2>
        {view ? (
          <form
            className="goal-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {mode === 'edit' ? (
              <>
                <label>
                  任务标题
                  <input
                    required
                    maxLength={256}
                    value={title}
                    disabled={busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                {view.canEditObjective ? (
                  <label>
                    任务目标
                    <textarea
                      required
                      rows={5}
                      maxLength={100_000}
                      value={objective}
                      disabled={busy}
                      onChange={(event) => setObjective(event.target.value)}
                    />
                  </label>
                ) : null}
              </>
            ) : (
              <>
                <h3>{view.task.title}</h3>
                <p>{view.task.objective}</p>
              </>
            )}
            <p>
              {mode === 'delete' && view.canDelete
                ? '删除这条未执行草稿，保留项目审计记录。此操作不会删除工作区文件。'
                : view.reason}
            </p>
            {mode === 'start' ? (
              <>
                <p>执行 Boss：{boss?.name ?? '尚未选择'}。确认后开始调用 Agent。</p>
                {directory ? <DirectoryExecutionNotice rootPath={directory.rootPath} /> : null}
              </>
            ) : null}
            {mode !== 'edit' ? (
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                {mode === 'delete'
                  ? '确认删除这条草稿'
                  : '确认开始执行，并允许 Agent 按目标操作工作区'}
              </label>
            ) : null}
            {error ? <p role="alert">{error} 可关闭后重新打开，查看最新记录。</p> : null}
            <div className="form-actions">
              <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
                取消
              </button>
              <button
                type="submit"
                disabled={
                  busy ||
                  (mode === 'edit'
                    ? !title.trim() || (view.canEditObjective && !objective.trim())
                    : !accepted ||
                      (mode === 'delete'
                        ? !view.canDelete
                        : !view.canEditObjective ||
                          !boss ||
                          Boolean(directory && !directory.version)))
                }
              >
                {busy
                  ? '处理中…'
                  : mode === 'edit'
                    ? '保存修改'
                    : mode === 'delete'
                      ? '确认删除'
                      : '确认启动'}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  );
}
