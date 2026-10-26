import { useState } from 'react';
import { api } from './http';
import type { Snapshot, Task } from './view-model';

const labels: Record<string, string> = {
  unconfigured: '待选择',
  'task-local': '独立任务目录',
  'git-worktree': '独立 Git worktree',
  'shared-directory': '共享项目目录',
};
export function WorkspaceModePanel({
  projectId,
  snapshot,
  onSaved,
}: {
  projectId: string;
  snapshot: Snapshot;
  onSaved: () => Promise<void>;
}) {
  const config = snapshot.workspaceConfigs?.find((item) => item.id === projectId);
  const [mode, setMode] = useState(config?.mode === 'unconfigured' ? '' : (config?.mode ?? ''));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = snapshot.executionAttempts?.some(
    (attempt) =>
      ['queued', 'running', 'waiting'].includes(attempt.state) &&
      snapshot.tasks.some((task) => task.id === attempt.taskId && task.projectId === projectId),
  );
  async function save() {
    if (!mode || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/workspace-mode`, {
        method: 'PUT',
        body: JSON.stringify({ mode }),
      });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '工作区设置未保存。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="execution-context-panel"
      open={!config || config.mode === 'unconfigured' ? true : undefined}
    >
      <summary>执行工作区 · {labels[config?.mode ?? 'unconfigured']}</summary>
      <p className="section-note">
        新分派使用下列模式；恢复任务继续使用已绑定的原目录。目录与 worktree 不提供操作系统隔离。
      </p>
      <label>
        工作区模式
        <select
          aria-label="工作区模式"
          value={mode}
          disabled={busy || active}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="" disabled>
            请选择
          </option>
          <option value="task-local">独立任务目录（新空目录）</option>
          <option value="git-worktree">独立 Git worktree（从项目当前提交创建分支）</option>
          <option value="shared-directory">共享项目目录（允许多个 Agent 写同一目录）</option>
        </select>
      </label>
      <p>
        {mode === 'git-worktree'
          ? '项目目录必须是已有提交的 Git 仓库。未提交改动不会复制；执行结果保留在任务分支，合并另行处理。'
          : mode === 'shared-directory'
            ? '选择并保存即明确允许共享写入；并行任务可能修改相同文件。'
            : '每次新分派从空目录开始；所需材料通过任务上下文和产物传递。'}
      </p>
      <button
        type="button"
        disabled={!mode || busy || active || mode === config?.mode}
        onClick={() => void save()}
      >
        {busy ? '保存中…' : '保存工作区模式'}
      </button>
      {active ? <small>项目有执行中的任务，结束后可更改模式。</small> : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}

export function TaskWorkspacePanel({ task, snapshot }: { task: Task; snapshot: Snapshot }) {
  const binding = snapshot.assignmentWorkspaces?.filter((item) => item.taskId === task.id).at(-1);
  const workspace = snapshot.workspaces.find((item) => item.id === binding?.workspaceId);
  const cleanup = snapshot.workspaceCleanups?.find((item) => item.id === binding?.workspaceId);
  if (!workspace || !binding) return null;
  return (
    <section className="context-section" aria-label="任务工作区">
      <h3>任务工作区</h3>
      <p>{labels[binding.mode]}</p>
      <code className="directory-path">{workspace.rootPath}</code>
      {workspace.branchName ? <p className="directory-path">分支：{workspace.branchName}</p> : null}
      <small>
        {cleanup
          ? cleanup.state === 'completed'
            ? '目录已清理，历史路径和产物仍保留；请创建新任务继续工作。'
            : '清理结果待核对，暂停原地恢复；请查看工作区清理记录。'
          : '任务结束后默认保留目录与分支；可在清理预览中检查是否能够释放。'}
      </small>
    </section>
  );
}
