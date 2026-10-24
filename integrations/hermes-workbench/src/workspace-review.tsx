import React, { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import { z } from 'zod';
import { fetchExternalText, fetchJSON, postJSON } from '@/lib/transport';
import s from './workspace-review.module.css';
import { patchForFile } from './file-patch';
import type { FileFocus } from './workspace-file-links';
import { useReviewWidth } from './review-layout';
import { diffLines } from './diff-lines';
import { ReviewFilePicker } from './review-file-picker';
import { LiveWorkspaceChanges } from './live-changes';

const GitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Review = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  taskId: z.string(),
  assignmentId: z.string(),
  workspaceId: z.string(),
  sourceWorkspaceId: z.string(),
  baseRevision: GitId,
  workspaceHead: GitId,
  snapshotCommit: GitId,
  mergeCommit: GitId,
  targetHead: GitId,
  targetBranch: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      status: z.enum(['A', 'M', 'D', 'T']),
      additions: z.number().int().nonnegative().nullable(),
      deletions: z.number().int().nonnegative().nullable(),
    }),
  ),
  patchArtifactId: z.string(),
  manifestArtifactId: z.string(),
  approvalId: z.string(),
  state: z.enum(['ready', 'applying', 'merged', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().optional(),
  failure: z.string().optional(),
});
const ReviewRows = z.array(
  z.object({
    review: Review,
    approvalState: z.enum(['pending', 'approved', 'rejected', 'expired']),
  }),
);
const Snapshot = z.object({
  generatedAt: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      title: z.string(),
      state: z.string(),
      parentTaskId: z.string().optional(),
    }),
  ),
  executionAttempts: z.array(z.object({ taskId: z.string(), state: z.string() })).default([]),
  workspaces: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      rootPath: z.string(),
      branchName: z.string().optional(),
    }),
  ),
  assignmentWorkspaces: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        workspaceId: z.string(),
        sourceWorkspaceId: z.string(),
        mode: z.string(),
      }),
    )
    .default([]),
  workspaceCleanups: z
    .array(z.object({ id: z.string(), taskId: z.string(), state: z.string() }))
    .default([]),
});
type SnapshotData = z.infer<typeof Snapshot>;
type Row = z.infer<typeof ReviewRows>[number];
type ReviewData = z.infer<typeof Review>;
const artifactUrl = (id: string) => `/api/artifacts/${encodeURIComponent(id)}/content`;
const reviewPath = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/workspace-reviews`;
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

function errorText(cause: unknown) {
  if (cause instanceof z.ZodError) return '服务器返回的审阅记录格式无法识别，请刷新后重试。';
  if (!(cause instanceof Error)) return '操作未完成，请刷新记录核对结果。';
  const body = cause.message.match(/^HTTP \d+:\s*([\s\S]*)$/)?.[1];
  if (body) {
    try {
      const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(body));
      if (parsed.success) return parsed.data.error;
    } catch {
      /* Preserve the status below when the server did not send JSON. */
    }
    return '服务器未完成操作，请刷新审阅记录核对结果。';
  }
  return cause.message;
}
function reviewStatus(row: Row) {
  if (row.review.state === 'merged') return '已合并到源项目';
  if (row.review.state === 'applying') return '合并结果待核对';
  if (row.review.state === 'failed') return '合并未完成';
  return {
    pending: '等待你审阅',
    approved: '已批准，待确认合并',
    rejected: '已拒绝',
    expired: '已失效',
  }[row.approvalState];
}
function scopeTasks(snapshot: SnapshotData, rootIds: string[]) {
  const ids = new Set(rootIds);
  for (let changed = true; changed; ) {
    changed = false;
    for (const task of snapshot.tasks) {
      if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  return snapshot.tasks.filter((task) => ids.has(task.id));
}

function PatchPreview({
  review,
  filePath,
  onFile,
}: {
  review: ReviewData;
  filePath?: string;
  onFile: (path: string | undefined) => void;
}) {
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem('control-plane-diff-wrap') === 'true';
    } catch {
      return false;
    }
  });
  const section = useRef<HTMLDivElement>(null);
  const [patch, setPatch] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (filePath && patch === undefined) void open();
  }, [filePath]);
  useEffect(() => {
    if (filePath && patch !== undefined) section.current?.scrollIntoView({ block: 'nearest' });
  }, [filePath, patch]);
  async function open() {
    if (pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    try {
      const metadata = await fetchJSON(
        `/api/artifacts/${encodeURIComponent(review.patchArtifactId)}`,
        { signal: controller.signal },
        z.object({
          id: z.string(),
          sizeBytes: z.number().int().nonnegative(),
          mimeType: z.string(),
        }),
      );
      if (metadata.id !== review.patchArtifactId)
        throw Error('变更产物与当前快照不一致，请重新读取。');
      if (metadata.sizeBytes > 2 * 1024 * 1024)
        throw Error('变更文件超过 2 MB，请下载完整补丁检查。');
      const content = await fetchExternalText(artifactUrl(review.patchArtifactId), {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPatch(content);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const selectedPatch =
    patch === undefined ? undefined : filePath ? patchForFile(patch, filePath) : patch;
  const visible = (selectedPatch ?? patch)?.slice(0, 120000);
  return (
    <div className={s.patchSection} ref={section}>
      <div className={s.actions}>
        <label className={s.diffSelector}>
          查看文件
          <select
            aria-label="差异文件"
            value={filePath ?? ''}
            onChange={(event) => onFile(event.target.value || undefined)}
          >
            <option value="">全部文件</option>
            {filePath && !review.files.some((file) => file.path === filePath) && (
              <option value={filePath}>{filePath}（不在快照中）</option>
            )}
            {review.files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loading}
          onClick={() => (patch === undefined ? void open() : setPatch(undefined))}
        >
          {loading ? '读取变更…' : patch === undefined ? '查看完整变更' : '收起变更'}
        </button>
        <a href={artifactUrl(review.patchArtifactId)} download>
          <Download size={14} /> 下载补丁
        </a>
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => {
            const next = !wrap;
            setWrap(next);
            try {
              localStorage.setItem('control-plane-diff-wrap', String(next));
            } catch {}
          }}
        >
          长行换行
        </button>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {visible !== undefined && (
        <>
          <p className={s.note}>
            {filePath ? `文件：${filePath}。` : ''}
            相对源项目目标提交的固定差异。绿色为新增，红色为删除。
          </p>
          {filePath && selectedPatch === undefined && (
            <p role="status" className={s.note}>
              此文件没有可单独提取的文本差异，下面显示完整补丁供核对。
            </p>
          )}
          {(selectedPatch ?? patch ?? '').length > 120000 && (
            <p className={s.note}>预览显示前 120,000 个字符；下载补丁可查看全部内容。</p>
          )}
          <pre className={s.diff} data-wrap={wrap} aria-label="变更补丁" tabIndex={0}>
            {diffLines(visible).map((line, index) => (
              <span key={index} className={s.diffLine} data-kind={line.kind}>
                <span
                  className={s.lineNumber}
                  aria-hidden="true"
                  data-line-number={line.before ?? ''}
                />
                <span
                  className={s.lineNumber}
                  aria-hidden="true"
                  data-line-number={line.after ?? ''}
                />
                <code>
                  {line.text}
                  {'\n'}
                </code>
              </span>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}

export function WorkspaceReviewPanel({
  taskIds,
  onClose,
  focus,
}: {
  taskIds: string[];
  onClose: () => void;
  focus?: FileFocus | null;
}) {
  const layout = useReviewWidth();
  const [snapshot, setSnapshot] = useState<SnapshotData>();
  const [reviews, setReviews] = useState<Record<string, Row[]>>({});
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedReviewId, setSelectedReviewId] = useState('');
  const [selectedFile, setSelectedFile] = useState<string>();
  useEffect(() => {
    if (focus) {
      setSelectedTaskId(focus.taskId);
      setSelectedReviewId('');
      setSelectedFile(focus.path);
    } else setSelectedFile(undefined);
  }, [focus]);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [approvedContent, setApprovedContent] = useState(false);
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const alive = useRef(false);
  // The caller supplies conversation rounds in chronological order. Keep that
  // order so a newly opened panel starts at the latest root round, not a worker.
  const scopeKey = JSON.stringify([...new Set(taskIds)]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scope = JSON.parse(scopeKey) as string[];
    async function refresh() {
      try {
        const data = await fetchJSON(
          '/api/control-center?view=conversation',
          { signal: controller.signal },
          Snapshot,
        );
        const tasks = scopeTasks(data, scope);
        const gitTaskIds = tasks
          .filter((task) =>
            data.assignmentWorkspaces.some(
              (binding) => binding.taskId === task.id && binding.mode === 'git-worktree',
            ),
          )
          .map((task) => task.id);
        const rows = await Promise.all(
          gitTaskIds.map(
            async (id) =>
              [
                id,
                await fetchJSON(reviewPath(id), { signal: controller.signal }, ReviewRows),
              ] as const,
          ),
        );
        const preferredTaskId = [...scope]
          .reverse()
          .find(
            (id) =>
              gitTaskIds.includes(id) &&
              data.tasks.some((task) => task.id === id && !task.parentTaskId),
          );
        if (!controller.signal.aborted) {
          setSnapshot(data);
          setReviews(Object.fromEntries(rows));
          setReadError('');
          setSelectedTaskId((current) =>
            gitTaskIds.includes(current) ? current : (preferredTaskId ?? gitTaskIds[0] ?? ''),
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted) setReadError(errorText(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [scopeKey, reload]);

  const tasks = snapshot ? scopeTasks(snapshot, taskIds) : [];
  const gitTasks = tasks.filter((task) =>
    snapshot?.assignmentWorkspaces.some(
      (binding) => binding.taskId === task.id && binding.mode === 'git-worktree',
    ),
  );
  const selected = gitTasks.find((task) => task.id === selectedTaskId);
  const rows = (selected ? (reviews[selected.id] ?? []) : [])
    .slice()
    .sort((a, b) => a.review.createdAt.localeCompare(b.review.createdAt));
  const latest = rows.at(-1);
  const current = rows.find((row) => row.review.id === selectedReviewId) ?? latest;
  const review = current?.review;
  const history = !!review && review.id !== latest?.review.id;
  const binding = snapshot?.assignmentWorkspaces
    .filter((item) => item.taskId === selected?.id)
    .at(-1);
  // Saved reviews retain their own workspace identity even if a later attempt has a different binding.
  const source = snapshot?.workspaces.find(
    (item) => item.id === (review?.sourceWorkspaceId ?? binding?.sourceWorkspaceId),
  );
  const workspace = snapshot?.workspaces.find(
    (item) => item.id === (review?.workspaceId ?? binding?.workspaceId),
  );
  const active =
    !!selected &&
    !!snapshot?.executionAttempts.some(
      (attempt) =>
        ['queued', 'running', 'waiting'].includes(attempt.state) &&
        snapshot.tasks.some(
          (task) => task.id === attempt.taskId && task.projectId === selected.projectId,
        ),
    );
  const cleaned = !!snapshot?.workspaceCleanups.some((item) => item.taskId === selected?.id);
  const taskEnded = !!selected && ['completed', 'failed', 'cancelled'].includes(selected.state);
  const snapshotKey = review
    ? `${selected?.id}:${review.id}:${review.mergeCommit}:${review.targetBranch}:${review.targetHead}`
    : '';
  useEffect(() => {
    setApprovedContent(false);
    setMergeConfirmed(false);
  }, [snapshotKey]);

  async function action(kind: 'prepare' | 'approve' | 'reject' | 'merge') {
    if (pending.current || !selected || (kind !== 'prepare' && !review)) return;
    if (kind === 'approve' && !approvedContent) return;
    if (kind === 'merge' && !mergeConfirmed) return;
    pending.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    setApprovedContent(false);
    setMergeConfirmed(false);
    const base = reviewPath(selected.id);
    const path =
      kind === 'prepare'
        ? base
        : `${base}/${encodeURIComponent(review!.id)}/${kind === 'merge' ? 'merge' : 'decision'}`;
    const body =
      kind === 'prepare'
        ? {}
        : kind === 'merge'
          ? {
              confirmedTargetBranch: review!.targetBranch,
              confirmedMergeCommit: review!.mergeCommit,
            }
          : { state: kind === 'approve' ? 'approved' : 'rejected' };
    try {
      const result = await postJSON(path, body, Review);
      if (alive.current) {
        if (kind === 'prepare') setSelectedReviewId(result.id);
        setNotice(
          kind === 'prepare'
            ? '快照已生成，请检查文件与差异。'
            : kind === 'approve'
              ? '已批准此快照。确认目标目录后，再执行本地合并。'
              : kind === 'reject'
                ? '已拒绝此快照。任务文件仍然保留。'
                : result.state === 'merged'
                  ? '快照已合并到源项目目录，任务工作树和分支仍然保留。'
                  : '合并请求已返回，请核对审阅状态。',
        );
      }
    } catch (cause) {
      if (alive.current) setActionError(errorText(cause));
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        setReload((value) => value + 1);
      }
    }
  }

  return (
    <aside
      className={s.panel}
      style={{ width: layout.width, flexBasis: layout.width }}
      aria-label="文件改动"
    >
      <div
        {...layout.separator}
        className={s.resizeHandle}
        title="拖动调宽；也可用左右方向键调整"
      />
      <header className={s.header}>
        <div>
          <h2>文件改动</h2>
          <p>检查任务工作树，再合入源项目</p>
        </div>
        <button type="button" onClick={layout.expand}>
          {layout.width >= Math.min(900, layout.maximum) ? '收窄面板' : '展开审阅'}
        </button>
        <button type="button" aria-label="关闭文件改动" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className={s.body}>
        {readError && (
          <div className={s.error} role="alert">
            <p>读取审阅记录失败：{readError}</p>
            <p>如仍显示旧记录，请先刷新后再操作。</p>
          </div>
        )}
        {!snapshot && !readError && <p role="status">正在读取工作区和审阅记录…</p>}
        <button
          className={s.refresh}
          type="button"
          disabled={busy}
          onClick={() => {
            setMergeConfirmed(false);
            setApprovedContent(false);
            setReload((value) => value + 1);
          }}
        >
          <RefreshCw size={14} /> 刷新记录
        </button>
        {snapshot && !gitTasks.length && (
          <div className={s.empty}>
            <strong>这段会话尚无独立 Git 工作树</strong>
            <p>
              文件审阅用于在独立工作树中完成的任务。共享文件夹中的操作会直接作用于该文件夹，不经过这里的合并步骤。
            </p>
            <p>新建任务时可选择 Git 项目，并使用独立工作树；分配工作区后可在这里查看。</p>
          </div>
        )}
        {selected && (
          <>
            <label className={s.selector}>
              查看任务
              <select
                value={selected.id}
                disabled={busy}
                onChange={(event) => {
                  setSelectedTaskId(event.target.value);
                  setSelectedFile(undefined);
                  setSelectedReviewId('');
                  setNotice('');
                  setActionError('');
                }}
              >
                {gitTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
            {!cleaned && <LiveWorkspaceChanges key={`live-${selected.id}`} taskId={selected.id} />}
            <div className={s.paths}>
              <strong>任务工作树</strong>
              <code>{workspace?.rootPath ?? '目录信息暂未提供'}</code>
              {workspace?.branchName && <small>任务分支：{workspace.branchName}</small>}
              <span className={s.direction}>↓ 经你审阅、批准并确认后合并</span>
              <strong>源项目目录</strong>
              <code>{source?.rootPath ?? '目录信息暂未提供'}</code>
              <small>
                目标分支：{review?.targetBranch ?? source?.branchName ?? '生成快照时确认当前分支'}
              </small>
            </div>
            <p className={s.note}>
              生成固定快照，包含已跟踪文件和未忽略的新文件。忽略文件、子模块内部未提交内容不在快照内。生成快照不会修改源项目分支或替你批准合并。
            </p>
            <div className={s.actions}>
              <button
                type="button"
                disabled={
                  busy ||
                  !!readError ||
                  active ||
                  cleaned ||
                  !taskEnded ||
                  current?.review.state === 'applying'
                }
                onClick={() => void action('prepare')}
              >
                {busy ? '处理中…' : latest ? '重新生成审阅快照' : '生成审阅快照'}
              </button>
            </div>
            {active ? (
              <p className={s.note}>项目仍有任务执行中，结束后可以生成或合并快照。</p>
            ) : !taskEnded ? (
              <p className={s.note}>此任务尚未结束，完成或停止后可以生成审阅。</p>
            ) : null}
            {cleaned && <p className={s.note}>工作区已进入清理流程，保留的审阅和补丁仍可查看。</p>}
            {notice && (
              <p className={s.notice} role="status">
                {notice}
              </p>
            )}
            {actionError && (
              <div className={s.error} role="alert">
                <strong>操作未完成</strong>
                <p>{actionError}</p>
                <p>以刷新后的记录为准；不会自动重试合并。</p>
              </div>
            )}
            {!review && (
              <p className={s.note}>尚无审阅快照。生成后会展示具体文件、完整差异和合并目标。</p>
            )}
            {review && current && (
              <>
                {rows.length > 1 && (
                  <label className={s.selector}>
                    审阅版本
                    <select
                      disabled={busy}
                      value={review.id}
                      onChange={(event) => {
                        setSelectedReviewId(event.target.value);
                        setNotice('');
                        setActionError('');
                      }}
                    >
                      {[...rows].reverse().map((row) => (
                        <option key={row.review.id} value={row.review.id}>
                          {time(row.review.createdAt)} · {reviewStatus(row)}
                          {row.review.id === latest?.review.id ? ' · 最新' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <section className={s.review} aria-label="审阅快照">
                  <h3>{reviewStatus(current)}</h3>
                  <p className={s.note}>
                    {time(review.createdAt)} · 快照 {review.mergeCommit.slice(0, 12)} ·{' '}
                    {review.files.length} 个文件
                  </p>
                  {history && (
                    <p className={s.note}>正在查看历史快照。切回最新版本后可以决定是否合并。</p>
                  )}
                  {review.state === 'merged' && (
                    <p className={s.notice}>
                      这些改动已经合入上述源项目的 {review.targetBranch}{' '}
                      分支。任务分支仍保留；此操作没有推送远端。
                    </p>
                  )}
                  {review.state === 'applying' && (
                    <p className={s.note}>
                      已开始合并，但还没有记录完成结果。先刷新；若状态持续不变，可重新确认同一快照，由服务器核对是否已合入。
                    </p>
                  )}
                  {review.failure && (
                    <p className={s.error} role="alert">
                      {review.failure}
                    </p>
                  )}
                  <ReviewFilePicker
                    key={`files-${review.id}`}
                    files={review.files}
                    selectedPath={selectedFile}
                    onSelect={setSelectedFile}
                  />
                  {selectedFile && (
                    <div className={s.actions}>
                      <button type="button" onClick={() => setSelectedFile(undefined)}>
                        查看全部文件差异
                      </button>
                    </div>
                  )}
                  {selectedFile && !review.files.some((file) => file.path === selectedFile) && (
                    <p className={s.note} role="status">
                      引用的文件 {selectedFile}{' '}
                      不在此快照的变更列表中；可选择其他快照或查看完整补丁。
                    </p>
                  )}
                  <PatchPreview
                    key={`patch-${review.id}`}
                    review={review}
                    filePath={selectedFile}
                    onFile={setSelectedFile}
                  />
                  {!history && review.state !== 'merged' && current.approvalState === 'pending' && (
                    <div className={s.decision}>
                      <label className={s.check}>
                        <input
                          type="checkbox"
                          disabled={busy || !!readError}
                          checked={approvedContent}
                          onChange={(event) => setApprovedContent(event.target.checked)}
                        />
                        我已查看此快照的文件和差异，同意其合入 {review.targetBranch}。
                      </label>
                      <div className={s.actions}>
                        <button
                          type="button"
                          disabled={
                            busy || !!readError || active || cleaned || !approvedContent || !source
                          }
                          onClick={() => void action('approve')}
                        >
                          批准此快照
                        </button>
                        <button
                          type="button"
                          disabled={busy || !!readError}
                          onClick={() => void action('reject')}
                        >
                          拒绝此快照
                        </button>
                      </div>
                      <p className={s.note}>批准只记录你的决定。下一步仍需单独确认写入源项目。</p>
                    </div>
                  )}
                  {!history &&
                    review.state !== 'merged' &&
                    current.approvalState === 'approved' && (
                      <div className={s.decision}>
                        <strong>确认写入源项目</strong>
                        <p>
                          将快照 <code>{review.mergeCommit.slice(0, 12)}</code> 合并到{' '}
                          <strong>{review.targetBranch}</strong>，会更新上方源项目目录及其本地分支。
                        </p>
                        <label className={s.check}>
                          <input
                            type="checkbox"
                            checked={mergeConfirmed}
                            disabled={busy || !!readError || active || cleaned || !source}
                            onChange={(event) => setMergeConfirmed(event.target.checked)}
                          />
                          确认目录、目标分支和此快照均正确。
                        </label>
                        <button
                          type="button"
                          className={s.merge}
                          disabled={
                            busy || !!readError || active || cleaned || !mergeConfirmed || !source
                          }
                          onClick={() => void action('merge')}
                        >
                          {review.state === 'applying' || review.state === 'failed'
                            ? '确认并核对 / 完成合并'
                            : '确认本地合并'}
                        </button>
                      </div>
                    )}
                  {!history &&
                    ['rejected', 'expired'].includes(current.approvalState) &&
                    review.state !== 'merged' && (
                      <p className={s.note}>此审批已结束。需要继续时，请重新生成并审阅新的快照。</p>
                    )}
                  <details className={s.technical}>
                    <summary>快照标识与执行边界</summary>
                    <dl>
                      <dt>目标原提交</dt>
                      <dd>{review.targetHead}</dd>
                      <dt>任务快照提交</dt>
                      <dd>{review.snapshotCommit}</dd>
                      <dt>拟合并提交</dt>
                      <dd>{review.mergeCommit}</dd>
                      <dt>审阅编号</dt>
                      <dd>{review.id}</dd>
                    </dl>
                    <a href={artifactUrl(review.manifestArtifactId)} download>
                      下载快照记录
                    </a>
                    <p>
                      本次合并由控制平面 Git 执行边界强制检查策略、审批和目标版本。LocalRunner 与
                      Git 工作树不是系统安全沙箱；Agent 自有工具不因此获得全面拦截保证。
                    </p>
                  </details>
                  <p className={s.note}>
                    合并只使用已批准的固定快照。目标分支有新提交或任务又有改动时，需要重新生成审阅。源项目有未提交内容或存在冲突时，服务器会拒绝合并并保留问题说明。
                  </p>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
