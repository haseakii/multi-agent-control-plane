import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { SnapshotRefresh } from './snapshot-refresh';
import { LiveCodeDiff } from './live-code-diff';
import s from './workspace-review.module.css';

const LiveChanges = z.object({
  workspaceId: z.string(),
  baseRevision: z.string(),
  observedAt: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['A', 'M', 'D', 'T', 'unknown']),
      note: z.string().optional(),
    }),
  ),
  detail: z
    .object({
      path: z.string(),
      before: z.string().optional(),
      after: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});
const labels = { A: '新增', M: '修改', D: '删除', T: '类型变化', unknown: '尚未比较' };

export function LiveWorkspaceChanges({ taskId }: { taskId: string }) {
  const [data, setData] = useState<z.infer<typeof LiveChanges>>();
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const reader = useRef<SnapshotRefresh<z.infer<typeof LiveChanges>> | undefined>(undefined);
  useEffect(() => {
    const next = new SnapshotRefresh(
      (signal) =>
        fetchJSON(
          `/api/tasks/${encodeURIComponent(taskId)}/live-changes${selected ? `?path=${encodeURIComponent(selected)}` : ''}`,
          { signal },
          LiveChanges,
        ),
      (value) => {
        setData(value);
        setError('');
      },
      (cause) => {
        let message = cause instanceof Error ? cause.message : '读取当前改动失败。';
        const body = message.match(/^HTTP \d+:\s*([\s\S]*)$/)?.[1];
        if (body) {
          try {
            message = z.object({ error: z.string() }).parse(JSON.parse(body)).error;
          } catch {
            message = '读取当前改动失败。';
          }
        }
        setError(message);
      },
      15_000,
      '读取当前改动超时。上次结果仍保留，可手动刷新或等待自动重试。',
    );
    reader.current = next;
    void next.refresh();
    const timer = paused ? undefined : setInterval(() => void next.refresh(), 4000);
    return () => {
      clearInterval(timer);
      next.dispose();
    };
  }, [taskId, selected, paused]);
  const files =
    data?.files.filter((file) =>
      file.path.toLowerCase().includes(query.trim().replaceAll('\\', '/').toLowerCase()),
    ) ?? [];
  const detail = data?.detail?.path === selected ? data.detail : undefined;
  return (
    <section className={s.review} aria-label="当前工作区改动">
      <h3>当前工作区改动</h3>
      <p className={s.note}>
        保存后自动更新，无需生成快照。这里是正在变化的内容；批准和合并使用下方固定快照。
      </p>
      <div className={s.actions}>
        {selected && (
          <button type="button" onClick={() => setSelected('')}>
            返回当前文件列表
          </button>
        )}
        <button type="button" onClick={() => setPaused((value) => !value)}>
          {paused ? '恢复自动更新改动' : '暂停自动更新改动'}
        </button>
        <button type="button" onClick={() => void reader.current?.refresh(true)}>
          刷新当前改动
        </button>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error} {data ? '下方保留上次读取结果。' : ''}
        </p>
      )}
      {!data && !error && <p role="status">正在读取当前文件…</p>}
      {data && (
        <>
          <p className={s.note} role="status">
            {paused ? '自动更新已暂停' : '每 4 秒更新'} · 上次读取{' '}
            {new Date(data.observedAt).toLocaleTimeString('zh-CN', { hour12: false })} ·{' '}
            {data.files.length} 个改动或待比较文件
          </p>
          <label className={s.selector}>
            搜索当前改动
            <input
              type="search"
              value={query}
              placeholder="输入路径或文件名"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {!data.files.length && <p>当前未发现内容改动。</p>}
          {!!data.files.length && !files.length && <p>没有匹配的文件，请调整搜索。</p>}
          <ul className={s.files}>
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  aria-pressed={selected === file.path}
                  onClick={() => setSelected(file.path)}
                >
                  <code>{file.path}</code>
                </button>
                <span>
                  {labels[file.status]}
                  {file.note ? ` · ${file.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {selected && (
            <div aria-label="实时文件内容对照">
              <h4>{selected}</h4>
              {!detail && <p role="status">正在读取所选文件…</p>}
              {detail?.note && <p>{detail.note}</p>}
              {detail?.before !== undefined && detail.after !== undefined && (
                <LiveCodeDiff key={selected} before={detail.before} after={detail.after} />
              )}
            </div>
          )}
          <details className={s.technical}>
            <summary>读取范围</summary>
            <p>
              包含 Git 基线文件、已跟踪文件和未忽略的新文件，忽略 CRLF/LF
              换行差异。链接、子模块和超过读取范围的文件会明确标为尚未比较。实时读取不运行 Git
              过滤器，过滤转换与文件模式以固定快照为准。
            </p>
          </details>
        </>
      )}
    </section>
  );
}
