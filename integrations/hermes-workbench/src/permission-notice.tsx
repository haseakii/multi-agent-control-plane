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
  const approvedCommands = requests.filter(
    (item) =>
      item.state === 'approved' &&
      ids.has(item.taskId!) &&
      item.acp?.review.action === 'process.execute',
  );
  if (!pending.length && !expired.length && !approvedCommands.length) return null;
  return (
    <section className={s.taskFeedback} aria-label="操作确认状态">
      {pending.length > 0 && (
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
      )}
      {!pending.length && approvedCommands.length > 0 && (
        <article className={s.approvedFeedback}>
          <strong>本轮命令已授权 · {approvedCommands.length} 项</strong>
          {approvedCommands.map((item) => (
            <button
              key={item.id}
              type="button"
              title={approvalSummary(item.resource).command}
              onClick={() => onLocate(item.id)}
            >
              查看授权记录
            </button>
          ))}
          <button onClick={onInspect}>查看执行记录</button>
        </article>
      )}
      {expired.length > 0 && (
        <details
          className={s.permissionHistory}
          open={expired.some((item) => ids.has(item.taskId!))}
        >
          <summary>历史过期记录（{expired.length}）</summary>
          <article>
            <p>
              过期请求未获批准，不等于你主动拒绝。历史详情仅供查看；需要补做时，在下方继续说明。
            </p>
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
        </details>
      )}
    </section>
  );
}
