import { z } from 'zod';
import { conversationRounds, taskFamily, type SnapshotData, type TaskData } from './adapter';
import s from './workbench.module.css';
import { approvalSummary } from './approval-summary';

const Expiration = z.object({ review: z.object({ expiresAt: z.string().datetime() }) });

/** Keep permission status visible even after a timed-out card leaves the chat. */
export function PermissionNotice({
  snapshot,
  task,
  onInspect,
  onLocate,
}: {
  snapshot: SnapshotData;
  task: TaskData;
  onInspect: () => void;
  onLocate: (id: string) => void;
}) {
  const ids = new Set(taskFamily(snapshot, task).map((member) => member.id));
  const historyIds = new Set(
    conversationRounds(snapshot, task.id)
      .filter((round) => round.projectId === task.projectId)
      .flatMap((round) => taskFamily(snapshot, round))
      .map((member) => member.id),
  );
  const requests = snapshot.approvals.filter(
    (item) => item.projectId === task.projectId && item.taskId && item.action === 'acp.tool',
  );
  const pending = requests.filter((item) => item.state === 'pending' && ids.has(item.taskId!));
  const expired = requests.filter(
    (item) => item.state === 'expired' && historyIds.has(item.taskId!),
  );
  if (!pending.length && !expired.length) return null;
  return (
    <section className={s.taskFeedback} aria-label="操作确认状态">
      {pending.length ? (
        <article>
          <strong>有 {pending.length} 项操作等待你确认</strong>
          {pending.map((item) => {
            const expiry = Expiration.safeParse(item.resource);
            return (
              <div key={item.id} className={s.pendingOperation}>
                <span>
                  <strong>{approvalSummary(item.resource).title}</strong>
                  <code>
                    {approvalSummary(item.resource).command ??
                      item.acp?.review.target?.split(/[\\/]/).at(-1) ??
                      item.acp?.review.tool ??
                      '成员操作'}
                  </code>
                  {expiry.success &&
                    ` · 请在 ${new Date(expiry.data.review.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 前处理`}
                </span>
                <button type="button" onClick={() => onLocate(item.id)}>
                  查看并确认
                </button>
              </div>
            );
          })}
          <p>每项操作单独确认；允许本次不会改变自动审批设置。合入源项目仍需审阅。</p>
        </article>
      ) : (
        <article>
          <strong>本会话有 {expired.length} 项历史操作确认已过期</strong>
          <p>过期请求未获批准，不等于你主动拒绝。历史详情仅供查看；需要补做时，在下方继续说明。</p>
          {expired.map((item) => {
            const summary = approvalSummary(item.resource);
            return (
              <div key={item.id} className={s.pendingOperation}>
                <span>
                  <strong>{summary.title} · 已过期</strong>
                  <code>{summary.command ?? summary.target ?? '成员操作'}</code>
                </span>
                <button type="button" onClick={() => onLocate(item.id)}>
                  查看过期请求
                </button>
              </div>
            );
          })}
          <button onClick={onInspect}>查看执行记录</button>
        </article>
      )}
    </section>
  );
}
