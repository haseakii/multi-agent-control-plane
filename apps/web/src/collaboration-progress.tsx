import { agentLabel, taskStateLabel } from './presentation';
import { taskAgentId, type Snapshot, type Task } from './view-model';

export function CollaborationProgress({
  task,
  snapshot,
  onSelectTask,
  onOpenArtifact,
}: {
  task: Task;
  snapshot: Snapshot;
  onSelectTask: (id: string) => void;
  onOpenArtifact: (id: string, trigger: HTMLElement) => void;
}) {
  const children = snapshot.tasks.filter((item) => item.parentTaskId === task.id);
  if (!children.length && !task.resultArtifactRefs.length) return null;
  const completed = children.filter((item) => item.state === 'completed').length;
  const resultLabel = (id: string, index: number) => {
    const kind = snapshot.artifacts.find((item) => item.id === id)?.kind;
    return (
      ({ report: '执行报告', diff: '代码变更', json: '结构化结果' } as Record<string, string>)[
        kind ?? ''
      ] ?? `成果 ${index + 1}`
    );
  };
  return (
    <section className="collaboration-progress" aria-label="协作进度">
      <div className="panel-heading">
        <h2>协作进度</h2>
        {children.length ? (
          <small>
            {completed} / {children.length} 个子任务已完成
          </small>
        ) : null}
      </div>
      {task.resultArtifactRefs.length ? (
        <div className="task-deliverables">
          <strong>当前任务成果</strong>
          {task.resultArtifactRefs.map((id, i) => (
            <button
              key={id}
              type="button"
              data-result-trigger={`progress:${task.id}:${id}`}
              onClick={(event) => onOpenArtifact(id, event.currentTarget)}
            >
              {resultLabel(id, i)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="collaboration-grid">
        {children.map((child) => (
          <article className="collaboration-card" key={child.id}>
            <div>
              <strong>{child.title}</strong>
              <span className="badge">{taskStateLabel(child.state)}</span>
            </div>
            <p>{agentLabel(taskAgentId(child, snapshot), snapshot)}</p>
            <p className="task-objective-excerpt">{child.objective}</p>
            <div className="card-actions">
              <button type="button" onClick={() => onSelectTask(child.id)}>
                查看子任务
              </button>
              {child.resultArtifactRefs.map((id, i) => (
                <button
                  key={id}
                  type="button"
                  data-result-trigger={`progress:${child.id}:${id}`}
                  onClick={(event) => onOpenArtifact(id, event.currentTarget)}
                >
                  {resultLabel(id, i)}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
