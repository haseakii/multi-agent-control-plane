import { ExecutionContextSchema } from '../../../packages/core/src/execution-context';
import type { TimelineEvent } from './view-model';

export function ExecutionContextPanel({
  events,
  taskId,
  onOpenArtifact,
}: {
  events: TimelineEvent[];
  taskId: string;
  onOpenArtifact: (id: string, trigger: HTMLElement) => void;
}) {
  const event = events
    .filter((item) => item.taskId === taskId && item.type === 'execution.context.prepared')
    .at(-1);
  const parsed = ExecutionContextSchema.safeParse(event?.payload?.context);
  if (!parsed.success) return null;
  const context = parsed.data;
  return (
    <details className="execution-context-panel">
      <summary>
        本次执行依据 · {context.artifacts.length} 份材料 · {context.dependencies.length} 项依赖 ·{' '}
        {context.acceptedMemory.length} 条项目记忆
      </summary>
      <p className="section-note">启动本次执行前保存的上下文。后续补充与消息在各自记录中显示。</p>
      {context.parent ? <p>上级目标：{context.parent.title}</p> : null}
      {context.project.description ? <p>项目说明：{context.project.description}</p> : null}
      {context.acceptedMemory.map((memory) => (
        <article key={memory.id} className="memory-entry">
          <strong>已采纳记忆 · {memory.title}</strong>
          <p className="message-content">{memory.content}</p>
          <small>
            采纳时间：{memory.reviewedAt ? new Date(memory.reviewedAt).toLocaleString() : '已记录'}
          </small>
          {memory.sourceArtifactIds.map((id, i) => (
            <button key={id} type="button" onClick={(e) => onOpenArtifact(id, e.currentTarget)}>
              记忆来源 {i + 1}
            </button>
          ))}
        </article>
      ))}
      {context.dependencies.map((item) => (
        <p key={item.id}>
          依赖：{item.title} · {item.state}
        </p>
      ))}
      {context.completedChildren.length ? (
        <p>已完成子任务：{context.completedChildren.map((item) => item.title).join('、')}</p>
      ) : null}
      <p>
        工作目录：<code>{context.workspace.rootPath}</code>
      </p>
      {context.workspace.branchName ? (
        <p className="directory-path">分支：{context.workspace.branchName}</p>
      ) : null}
      {context.artifacts.map((artifact, index) => (
        <article className="context-material" key={artifact.id}>
          <button
            type="button"
            data-result-trigger={`context:${taskId}:${artifact.id}`}
            onClick={(event) => onOpenArtifact(artifact.id, event.currentTarget)}
          >
            查看材料 {index + 1}
          </button>
          <small>
            {artifact.content === undefined
              ? '传入引用；完整内容保存在产物中'
              : '文本内容已纳入上下文'}
          </small>
        </article>
      ))}
      {context.previousAttempts.length ? (
        <p>已包含 {context.previousAttempts.length} 次此前执行的状态。</p>
      ) : null}
      {context.notes.length ? (
        <details>
          <summary>上下文裁剪说明</summary>
          {context.notes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </details>
      ) : null}
    </details>
  );
}
