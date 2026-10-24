import { useEffect, useState } from 'react';
import type { WorkspaceReview } from '../../../packages/core/src/workspace-review';
import type { Snapshot, Task } from './view-model';
import { api } from './http';
import { WorkspacePushPanel } from './workspace-push-panel';

type Row = { review: WorkspaceReview; approvalState: string };
export function WorkspaceReviewPanel({
  task,
  snapshot,
  onOpenArtifact,
  onSaved,
}: {
  task: Task;
  snapshot: Snapshot;
  onOpenArtifact: (id: string, trigger: HTMLElement) => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const path = '/api/tasks/' + encodeURIComponent(task.id) + '/workspace-reviews';
  const binding = snapshot.assignmentWorkspaces?.filter((item) => item.taskId === task.id).at(-1);
  async function refresh() {
    setRows(await api<Row[]>(path));
  }
  useEffect(() => {
    void refresh().catch(() => setError('审阅记录加载失败。'));
  }, [task.id]);
  if (binding?.mode !== 'git-worktree') return null;
  const current = rows.at(-1),
    review = current?.review;
  const source = snapshot.workspaces.find((item) => item.id === binding.sourceWorkspaceId);
  const active = snapshot.executionAttempts?.some(
    (attempt) =>
      ['queued', 'running', 'waiting'].includes(attempt.state) &&
      snapshot.tasks.some(
        (item) => item.id === attempt.taskId && item.projectId === task.projectId,
      ),
  );
  const cleaned = snapshot.workspaceCleanups?.some((item) => item.taskId === task.id);
  async function action(suffix: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      await api(path + suffix, { method: 'POST', body: JSON.stringify(body) });
      await refresh();
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请刷新确认。');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="execution-context-panel" aria-label="变更审阅">
      <h3>变更审阅与本地合并</h3>
      <p className="section-note">
        生成包含已跟踪文件和未忽略新文件的固定快照。批准后，再单独确认合并到项目目录。忽略文件和子模块内部未提交内容不在快照中。
      </p>
      <div className="memory-actions">
        <button
          disabled={
            busy || active || cleaned || !['completed', 'failed', 'cancelled'].includes(task.state)
          }
          onClick={() => void action('', {})}
        >
          {busy ? '处理中…' : '生成变更审阅'}
        </button>
        <button disabled={busy} onClick={() => void refresh().catch(() => setError('刷新失败。'))}>
          刷新审阅
        </button>
      </div>
      {active ? <p>项目仍有任务在执行，结束后可生成审阅或合并。</p> : null}
      {cleaned ? <p>工作区已进入清理流程，已保存的审阅和产物仍可查看。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {review && current ? (
        <>
          <p>
            目标分支：<strong>{review.targetBranch}</strong> · {review.files.length} 个变更文件
          </p>
          <p className="directory-path">项目目录：{source?.rootPath}</p>
          <p>
            生成于 {new Date(review.createdAt).toLocaleString()} ·{' '}
            {review.state === 'merged'
              ? '已合并'
              : current.approvalState === 'approved'
                ? '已批准，等待单独合并'
                : current.approvalState === 'pending'
                  ? '等待审阅决定'
                  : '审批已结束，请重新生成'}
          </p>
          <ul>
            {review.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code> ·{' '}
                {{ A: '新增', M: '修改', D: '删除', T: '类型变更' }[file.status]} ·{' '}
                {file.additions === null ? '二进制' : `+${file.additions} / −${file.deletions}`}
              </li>
            ))}
          </ul>
          <div className="memory-actions">
            <button
              onClick={(event) => onOpenArtifact(review.patchArtifactId, event.currentTarget)}
            >
              查看完整变更
            </button>
            <button
              onClick={(event) => onOpenArtifact(review.manifestArtifactId, event.currentTarget)}
            >
              查看快照记录
            </button>
          </div>
          {review.failure ? <p role="alert">{review.failure}</p> : null}
          {current.approvalState === 'pending' ? (
            <div className="memory-actions">
              <button
                disabled={busy}
                onClick={() => void action('/' + review.id + '/decision', { state: 'approved' })}
              >
                批准此合并快照
              </button>
              <button
                disabled={busy}
                onClick={() => void action('/' + review.id + '/decision', { state: 'rejected' })}
              >
                拒绝
              </button>
            </div>
          ) : null}
          {current.approvalState === 'approved' && review.state !== 'merged' ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已查看变更，确认将此快照合并到 {review.targetBranch}
              </label>
              <button
                disabled={busy || active || !confirmed}
                onClick={() =>
                  void action('/' + review.id + '/merge', {
                    confirmedTargetBranch: review.targetBranch,
                    confirmedMergeCommit: review.mergeCommit,
                  })
                }
              >
                确认本地合并
              </button>
            </>
          ) : null}
          <details>
            <summary>提交标识与历史审阅</summary>
            <p className="directory-path">目标提交：{review.targetHead}</p>
            <p className="directory-path">合并提交：{review.mergeCommit}</p>
            {rows.slice(0, -1).map((row) => (
              <p key={row.review.id}>
                {new Date(row.review.createdAt).toLocaleString()} · {row.review.state}{' '}
                <button
                  onClick={(event) =>
                    onOpenArtifact(row.review.patchArtifactId, event.currentTarget)
                  }
                >
                  历史变更
                </button>
              </p>
            ))}
          </details>
          <p className="section-note">
            只合并固定快照。后来产生的改动需另行审阅；目标分支变化后需重新生成。任务目录与分支保留，不自动推送或清理。
          </p>
          {review.state === 'merged' ? (
            <WorkspacePushPanel
              key={review.id}
              review={review}
              active={Boolean(active)}
              onSaved={onSaved}
            />
          ) : null}
        </>
      ) : (
        <p>尚未生成审阅。</p>
      )}
    </section>
  );
}
