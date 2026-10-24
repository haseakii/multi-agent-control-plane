import { z } from 'zod';
import { taskFamily, type SnapshotData, type TaskData } from './adapter';
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
  const requests = snapshot.approvals.filter(
    (item) => item.taskId && ids.has(item.taskId) && item.action === 'acp.tool',
  );
  const pending = requests.filter((item) => item.state === 'pending');
  const expired = requests.filter((item) => item.state === 'expired');
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
          <strong>本轮有 {expired.length} 项操作确认已过期</strong>
          <p>过期请求未获批准，确认按钮已关闭。请核对实际结果；需要补做时，在下方继续发送要求。</p>
          <p>
            涉及文件：
            {[
              ...new Set(
                expired.map((item) => item.acp?.review.target?.split(/[\\/]/).at(-1) ?? '未提供'),
              ),
            ].join('、')}
          </p>
          <button onClick={onInspect}>查看执行记录</button>
        </article>
      )}
    </section>
  );
}
