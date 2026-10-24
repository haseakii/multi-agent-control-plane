import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { SnapshotRefresh } from './snapshot-refresh';

// Presentation comes from the server used by the MCP gateway. No browser-side
// classification of task state, failure text or approvals.
const RecoveryView = z.object({
  latestTaskId: z.string(),
  diagnostic: z.object({
    reason: z.string(),
    title: z.string(),
    message: z.string(),
    observedAt: z.string(),
    pendingApprovals: z.object({
      execution: z.number().int().nonnegative(),
      review: z.number().int().nonnegative(),
      push: z.number().int().nonnegative(),
    }),
  }),
});
export function TaskRecovery({ taskId }: { taskId: string }) {
  const [value, setValue] = useState<z.infer<typeof RecoveryView>>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setValue(undefined);
    setError('');
    const reader = new SnapshotRefresh(
      (signal) =>
        fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/recovery`, { signal }, RecoveryView),
      (next) => {
        setValue(next);
        setError('');
      },
      () => {
        setValue(undefined);
        setError('诊断暂时无法读取，请检查服务连接。');
      },
    );
    async function refresh() {
      await reader.refresh();
      if (!disposed) timer = setTimeout(() => void refresh(), 2500);
    }
    void refresh();
    return () => {
      disposed = true;
      reader.dispose();
      clearTimeout(timer);
    };
  }, [taskId]);
  return (
    <section aria-label="任务恢复诊断" data-recovery-reason={value?.diagnostic.reason}>
      <h3>当前诊断 · 与 Codex 协作接口同步</h3>
      {error ? (
        <p role="status">{error}</p>
      ) : !value ? (
        <p>正在读取诊断…</p>
      ) : (
        <>
          <strong>{value.diagnostic.title}</strong>
          <p>{value.diagnostic.message}</p>
          <p>
            待执行授权：{value.diagnostic.pendingApprovals.execution} · 待审阅合并：
            {value.diagnostic.pendingApprovals.review} · 待推送审批：
            {value.diagnostic.pendingApprovals.push}
          </p>
          {value.latestTaskId !== taskId && (
            <a href={`/?task=${encodeURIComponent(value.latestTaskId)}`}>打开最新轮次</a>
          )}
          <p>审阅和推送审批单独保留，不代表成员正在等待执行授权。查询诊断不会重试或批准操作。</p>
        </>
      )}
    </section>
  );
}
