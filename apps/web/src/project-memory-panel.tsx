import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectMemory, ContextSearchHit } from '../../../packages/core/src/project-memory';
import type { Snapshot } from './view-model';
import { api } from './http';

const kinds = { fact: '事实', constraint: '约束', decision: '决定', issue: '待解决问题' } as const;
const statuses = {
  proposed: '待采纳',
  accepted: '已采纳',
  rejected: '已拒绝',
  archived: '已归档',
} as const;
type SearchResult = {
  hits: ContextSearchHit[];
  unindexedArtifacts: number;
  indexPrefixBytes: number;
};

export function ProjectMemoryPanel({
  projectId,
  snapshot,
  onOpenArtifact,
}: {
  projectId: string;
  snapshot: Snapshot;
  onOpenArtifact: (id: string, trigger: HTMLElement) => void;
}) {
  const path = '/api/projects/' + encodeURIComponent(projectId);
  const [entries, setEntries] = useState<ProjectMemory[]>([]);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<ProjectMemory['kind']>('fact');
  const [title, setTitle] = useState(''),
    [content, setContent] = useState('');
  const [sourceTaskId, setSourceTaskId] = useState(''),
    [sourceArtifactIds, setSourceArtifactIds] = useState<string[]>([]);
  const [supersedesId, setSupersedesId] = useState<string>(),
    [formOpen, setFormOpen] = useState(false);
  const [filter, setFilter] = useState('active'),
    [query, setQuery] = useState('');
  const [source, setSource] = useState(''),
    [result, setResult] = useState<SearchResult>();
  const [searchBusy, setSearchBusy] = useState(false);
  const tasks = snapshot.tasks.filter((item) => item.projectId === projectId);
  const artifacts = snapshot.artifacts.filter((item) => item.projectId === projectId);
  const taskTitle = (id?: string) => tasks.find((item) => item.id === id)?.title ?? id;
  const memoryEvents = snapshot.timeline
    .filter((event) => event.projectId === projectId && event.type.startsWith('memory.'))
    .map((event) => event.id)
    .join(',');
  async function refresh() {
    setEntries(await api<ProjectMemory[]>(path + '/memory'));
  }
  useEffect(() => {
    void refresh().catch(() => setError('记忆加载失败，请刷新。'));
  }, [projectId, memoryEvents]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path + '/memory', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          title,
          content,
          sourceArtifactIds,
          ...(sourceTaskId ? { sourceTaskId } : {}),
          ...(supersedesId ? { supersedesId } : {}),
        }),
      });
      setTitle('');
      setContent('');
      setSourceTaskId('');
      setSourceArtifactIds([]);
      setSupersedesId(undefined);
      setFormOpen(false);
      setFilter('active');
      setResult(undefined);
      setNotice('提案已保存。采纳后将用于后续执行，当前执行的依据不会改变。');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存未确认，请刷新记录后核对。');
    } finally {
      setBusy(false);
    }
  }
  async function review(id: string, action: 'accept' | 'reject' | 'archive') {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path + '/memory/' + encodeURIComponent(id) + '/review', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setResult(undefined);
      setNotice(
        action === 'accept'
          ? '已采纳，将带入后续执行的上下文。'
          : action === 'archive'
            ? '已归档，后续执行不再默认使用。'
            : '已拒绝，保留提案记录。',
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (searchBusy) return;
    setSearchBusy(true);
    setError('');
    setResult(undefined);
    try {
      const params = new URLSearchParams({ query, ...(source ? { source } : {}) });
      setResult(await api<SearchResult>(path + '/knowledge?' + params));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '检索失败。');
    } finally {
      setSearchBusy(false);
    }
  }
  function revise(entry: ProjectMemory) {
    setKind(entry.kind);
    setTitle(entry.title);
    setContent(entry.content);
    setSourceTaskId(entry.sourceTaskId ?? '');
    setSourceArtifactIds(entry.sourceArtifactIds);
    setSupersedesId(entry.id);
    setFormOpen(true);
  }
  const visible = entries.filter(
    (entry) =>
      filter === 'all' ||
      (filter === 'active'
        ? entry.status === 'accepted' || entry.status === 'proposed'
        : entry.status === filter),
  );
  return (
    <details className="execution-context-panel project-memory-panel">
      <summary>
        项目记忆 · {entries.filter((e) => e.status === 'accepted').length} 条已采纳 ·{' '}
        {entries.filter((e) => e.status === 'proposed').length} 条待采纳
      </summary>
      <p className="section-note">
        保存项目事实、约束与决定。提案经人工采纳后，后续执行会按容量优先使用约束和决定；具体内容见“本次执行依据”。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh().catch(() => setError('记忆加载失败，请刷新。'))}
      >
        刷新记忆
      </button>
      <form onSubmit={search} className="memory-search">
        <label>
          查找项目知识
          <input
            aria-label="查找项目知识"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            required
            maxLength={256}
            placeholder="查找已采纳记忆和文本产物"
          />
        </label>
        <label>
          搜索范围
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">记忆与产物</option>
            <option value="memory">已采纳记忆</option>
            <option value="artifact">文本产物</option>
          </select>
        </label>
        <button disabled={searchBusy || !query.trim()}>{searchBusy ? '检索中…' : '检索'}</button>
      </form>
      {result ? (
        <section aria-label="知识检索结果">
          <p>找到 {result.hits.length} 条结果（最多显示 20 条）</p>
          {result.unindexedArtifacts ? (
            <p className="section-note">
              还有 {result.unindexedArtifacts}{' '}
              份历史文本产物未纳入检索。再次检索会继续补录小文件；历史大文件仍需从产物中查看。
            </p>
          ) : null}
          {result.hits.map((hit) => (
            <article className="memory-entry" key={hit.source + hit.id}>
              <strong>
                {hit.source === 'memory' ? '记忆 · ' : '产物 · '}
                {hit.title}
              </strong>
              <p className="message-content">{hit.excerpt}</p>
              {hit.taskId ? <small>来源任务：{taskTitle(hit.taskId)}</small> : null}
              {hit.truncated ? <small>仅检索了前 256 KiB，请打开完整产物。</small> : null}
              {hit.source === 'artifact' ? (
                <button type="button" onClick={(e) => onOpenArtifact(hit.id, e.currentTarget)}>
                  查看完整产物
                </button>
              ) : (
                <details>
                  <summary>查看记忆全文与来源</summary>
                  <p className="message-content">{entries.find((e) => e.id === hit.id)?.content}</p>
                  {entries
                    .find((e) => e.id === hit.id)
                    ?.sourceArtifactIds.map((id, i) => (
                      <button
                        key={id}
                        type="button"
                        onClick={(e) => onOpenArtifact(id, e.currentTarget)}
                      >
                        来源产物 {i + 1}
                      </button>
                    ))}
                </details>
              )}
            </article>
          ))}
        </section>
      ) : null}
      <details open={formOpen} onToggle={(e) => setFormOpen(e.currentTarget.open)}>
        <summary>{supersedesId ? '修订已采纳记忆' : '记录新提案'}</summary>
        <form onSubmit={submit} className="memory-form">
          <label>
            类型
            <select value={kind} onChange={(e) => setKind(e.target.value as ProjectMemory['kind'])}>
              {Object.entries(kinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            记忆标题
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={160}
            />
          </label>
          <label>
            记忆内容
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              maxLength={4000}
              rows={4}
            />
          </label>
          <label>
            来源任务（可选）
            <select value={sourceTaskId} onChange={(e) => setSourceTaskId(e.target.value)}>
              <option value="">项目级记录</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          {artifacts.length ? (
            <label>
              来源产物（可多选，最多 16 份）
              <select
                multiple
                value={sourceArtifactIds}
                onChange={(e) =>
                  setSourceArtifactIds(
                    Array.from(e.target.selectedOptions, (o) => o.value).slice(0, 16),
                  )
                }
              >
                {artifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {taskTitle(artifact.taskId) ?? '项目'} · {artifact.kind} ·{' '}
                    {artifact.id.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {supersedesId ? <p>采纳此修订时会归档原记忆，历史执行依据仍保留原版本。</p> : null}
          <button disabled={busy || !title.trim() || !content.trim()}>保存提案</button>
          {supersedesId ? (
            <button
              type="button"
              onClick={() => {
                setSupersedesId(undefined);
                setTitle('');
                setContent('');
              }}
            >
              取消修订
            </button>
          ) : null}
        </form>
      </details>
      <label>
        记忆记录
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="active">已采纳与待采纳</option>
          <option value="proposed">待采纳</option>
          <option value="accepted">已采纳</option>
          <option value="all">全部（含归档和拒绝）</option>
        </select>
      </label>
      {!visible.length ? (
        <p className="section-note">暂无记录。可把已确认的项目要求或任务结论保存为提案。</p>
      ) : null}
      {visible
        .slice()
        .reverse()
        .map((entry) => (
          <article className="memory-entry" key={entry.id}>
            <strong>
              {kinds[entry.kind]} · {entry.title}
            </strong>{' '}
            <span className="badge">{statuses[entry.status]}</span>
            <p className="message-content">{entry.content}</p>
            <small>
              来源：
              {entry.proposedBy.type === 'agent'
                ? 'Agent · ' +
                  (snapshot.agents.find((agent) => agent.definition.id === entry.proposedBy.id)
                    ?.definition.name ?? entry.proposedBy.id)
                : '本机操作台'}
              {entry.sourceTaskId ? ' · ' + taskTitle(entry.sourceTaskId) : ''} ·{' '}
              {new Date(entry.createdAt).toLocaleString()}
            </small>
            {entry.supersedesId ? (
              <small>
                修订：
                {entries.find((e) => e.id === entry.supersedesId)?.title ?? entry.supersedesId}
              </small>
            ) : null}
            <div className="memory-actions">
              {entry.sourceArtifactIds.map((id, index) => (
                <button key={id} type="button" onClick={(e) => onOpenArtifact(id, e.currentTarget)}>
                  来源产物 {index + 1}
                </button>
              ))}
              {entry.status === 'proposed' ? (
                <>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void review(entry.id, 'accept')}
                  >
                    采纳
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void review(entry.id, 'reject')}
                  >
                    拒绝
                  </button>
                </>
              ) : null}
              {entry.status === 'accepted' ? (
                <>
                  <button disabled={busy} type="button" onClick={() => revise(entry)}>
                    提案修订
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void review(entry.id, 'archive')}
                  >
                    归档
                  </button>
                </>
              ) : null}
            </div>
          </article>
        ))}
    </details>
  );
}
