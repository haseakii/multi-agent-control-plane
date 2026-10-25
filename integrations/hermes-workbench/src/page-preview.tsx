import React, { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Pause, Play } from 'lucide-react';
import { z } from 'zod';
import type { TaskData } from './adapter';
import s from './page-preview.module.css';

const Status = z.object({
  id: z.string(),
  taskId: z.string(),
  workspaceId: z.string(),
  rootPath: z.string(),
  state: z.enum(['ready', 'waiting']),
  url: z.string().url(),
  entry: z.string(),
  entries: z.array(z.string()),
  revision: z.string(),
  updatedAt: z.string(),
  fileCount: z.number(),
});
type Preview = z.infer<typeof Status>;
const Document = z.object({ html: z.string(), revision: z.string(), url: z.string().url() });
export function PagePreview({ tasks, onClose }: { tasks: TaskData[]; onClose: () => void }) {
  const latest = tasks.at(-1)?.id ?? '';
  const conversationRoot = tasks[0]?.id ?? '';
  const previousConversation = useRef(conversationRoot);
  const [taskId, setTaskId] = useState(latest),
    [entry, setEntry] = useState<string>();
  const [status, setStatus] = useState<Preview>(),
    [error, setError] = useState('');
  const [document, setDocument] = useState<z.infer<typeof Document> & { refresh: number }>();
  const [paused, setPaused] = useState(false),
    [mobile, setMobile] = useState(false);
  const [pageError, setPageError] = useState(''),
    [reload, setReload] = useState(0);
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    setTaskId(latest);
    if (previousConversation.current !== conversationRoot) {
      previousConversation.current = conversationRoot;
      setEntry(undefined);
    }
  }, [latest, conversationRoot]);
  useEffect(() => {
    if (!taskId) return;
    let disposed = false,
      previewId: string | undefined,
      timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    setStatus(undefined);
    setDocument(undefined);
    setError('');
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(taskId)}/live-preview${previewId ? '/' + previewId : ''}`,
          {
            method: previewId ? 'GET' : 'POST',
            signal: abort.signal,
            cache: 'no-store',
            ...(!previewId
              ? {
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(entry ? { entry } : {}),
                }
              : {}),
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(typeof data.error === 'string' ? data.error : '正在重新连接工作区…');
        const next = Status.parse(data),
          url = new URL(next.url);
        if (
          url.protocol !== 'http:' ||
          !/^preview-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
          url.origin === location.origin
        )
          throw new Error('预览地址无效。');
        if (disposed) return;
        previewId = next.id;
        setStatus(next);
        setError('');
      } catch (cause) {
        if (disposed) return;
        previewId = undefined;
        setError(cause instanceof Error ? cause.message : '正在重新连接工作区…');
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1200);
      }
    };
    void poll();
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [taskId, entry]);
  useEffect(() => {
    if (!status || status.state !== 'ready' || (paused && document?.refresh === reload)) return;
    const abort = new AbortController();
    let disposed = false;
    setPageError('');
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/live-preview/${status.id}/document`, {
      signal: abort.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(typeof body.error === 'string' ? body.error : '页面加载失败。');
        return Document.parse(body);
      })
      .then((next) => {
        if (!disposed) setDocument({ ...next, refresh: reload });
      })
      .catch((cause) => {
        if (!disposed) setPageError(cause instanceof Error ? cause.message : '页面加载失败。');
      });
    return () => {
      disposed = true;
      abort.abort();
    };
  }, [status?.id, status?.revision, status?.state, taskId, paused, reload]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== 'null') return;
      const parsed = z
        .object({
          type: z.enum(['control-plane-preview-ready', 'control-plane-preview-error']),
          revision: z.string(),
          message: z.string().max(1000),
        })
        .safeParse(event.data);
      if (!parsed.success || parsed.data.revision !== document?.revision) return;
      if (parsed.data.type === 'control-plane-preview-error') setPageError(parsed.data.message);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [document?.revision]);
  return (
    <aside className={s.panel} aria-label="页面预览">
      <header>
        <div>
          <h2>实时预览</h2>
          <small>跟随任务工作区，保存文件后自动更新</small>
        </div>
        <button aria-label="关闭页面预览" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className={s.toolbar}>
        <label>
          查看轮次
          <select
            aria-label="预览轮次"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
          >
            {tasks.map((task, i) => (
              <option key={task.id} value={task.id}>
                第 {i + 1} 轮 · {task.title}
              </option>
            ))}
          </select>
        </label>
        {status && status.entries.length > 1 && (
          <label>
            页面
            <select
              aria-label="预览页面"
              value={status.entry}
              onChange={(event) => setEntry(event.target.value)}
            >
              {status.entries.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
        )}
        <button onClick={() => setPaused((value) => !value)}>
          {paused ? <Play size={14} /> : <Pause size={14} />}{' '}
          {paused ? '恢复自动更新' : '暂停自动更新'}
        </button>
        <button onClick={() => setMobile((value) => !value)}>
          {mobile ? '桌面宽度' : '手机宽度'}
        </button>
        <button
          aria-label="重新加载预览"
          disabled={!document}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <p className={s.note} role="status">
        {error
          ? `连接中：${error}`
          : !status
            ? '正在连接任务工作区…'
            : status.state === 'waiting'
              ? '等待页面文件。Agent 创建 HTML 后会自动准备预览。'
              : `${paused ? '已暂停自动更新' : '保存后自动更新'} · ${status.entry} · ${status.fileCount} 个页面资源`}
      </p>
      {error && entry && (
        <button type="button" onClick={() => setEntry(undefined)}>
          返回默认预览页面
        </button>
      )}
      {pageError && (
        <p role="alert" className={s.error}>
          {pageError} 可直接在左侧要求 Agent 修复。
        </p>
      )}
      {document ? (
        <div className={s.stage}>
          <iframe
            ref={iframe}
            key={`${taskId}:${document.revision}:${reload}`}
            title="任务页面交互预览"
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            srcDoc={document.html}
            style={{ width: mobile ? '390px' : '100%' }}
          />
        </div>
      ) : (
        <div className={s.empty}>
          <strong>代码写好就能在这里看见</strong>
          <p>支持多文件 HTML、CSS、JavaScript 模块与已有构建产物。</p>
        </div>
      )}
      {status && (
        <details className={s.source}>
          <summary>正在预览的工作区</summary>
          <p>{status.rootPath}</p>
          <p>这里展示任务工作区。到“文件改动”审阅并确认后，才会写入源项目。</p>
        </details>
      )}
    </aside>
  );
}
