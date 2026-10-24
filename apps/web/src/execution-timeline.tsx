import type { Snapshot, TimelineEvent } from './view-model';
import { isRoutineEvent } from './view-model';
import { actorLabel, eventLabel, outcomeLabel } from './presentation';

export function ExecutionTimeline({
  events,
  snapshot,
}: {
  events: TimelineEvent[];
  snapshot: Snapshot | null;
}) {
  const routine = events.filter(isRoutineEvent);
  const milestones = events.filter((event) => !isRoutineEvent(event));
  const entries = (items: TimelineEvent[]) => (
    <ol className="timeline">
      {items.map((event) => (
        <li
          key={event.id}
          data-attention={
            /failed|denied|approval|interrupt/.test(event.type) ||
            ['failed', 'denied'].includes(String(event.payload?.outcome))
          }
        >
          <span aria-hidden="true" />
          <div>
            <strong>{eventLabel(event.type)}</strong>
            {['failed', 'denied'].includes(String(event.payload?.outcome)) ? (
              <small>结果：{outcomeLabel(String(event.payload?.outcome))}</small>
            ) : null}
            <small>
              {actorLabel(event.actor, snapshot)} ·{' '}
              {new Date(event.occurredAt).toLocaleTimeString()}
            </small>
            <details className="technical-details">
              <summary>技术详情</summary>
              <dl>
                <dt>事件类型</dt>
                <dd>{event.type}</dd>
                <dt>事件 ID</dt>
                <dd>{event.id}</dd>
                <dt>主体类型</dt>
                <dd>{event.actor.type ?? '未提供'}</dd>
                <dt>主体 ID</dt>
                <dd>{event.actor.id}</dd>
                <dt>任务 ID</dt>
                <dd>{event.taskId ?? '项目级事件'}</dd>
                {typeof event.payload?.stage === 'string' ? (
                  <>
                    <dt>执行阶段</dt>
                    <dd>{event.payload.stage}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          </div>
        </li>
      ))}
    </ol>
  );
  return (
    <section className="execution-record" aria-label="执行记录">
      <h2>执行记录</h2>
      <p className="section-note">来自已保存的执行事件；普通工具与消息投递记录可展开查看。</p>
      {events.length === 0 ? <p className="empty">当前任务范围还没有执行记录。</p> : null}
      {entries(milestones)}
      {routine.length ? (
        <details className="routine-events">
          <summary>工具与消息记录（{routine.length}）</summary>
          {entries(routine)}
        </details>
      ) : null}
    </section>
  );
}
