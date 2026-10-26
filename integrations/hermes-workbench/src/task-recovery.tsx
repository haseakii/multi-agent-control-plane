import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { SnapshotRefresh } from './snapshot-refresh';
import { EffectiveNetwork } from './network-settings-model';

// Presentation comes from the server used by the MCP gateway. No browser-side
// classification of task state, failure text or approvals.
const RecoveryView = z.object({
  latestTaskId: z.string(),
  network: z
    .object({
      current: z
        .object({
          agentId: z.string(),
          effective: EffectiveNetwork,
          state: z.enum(['prepared', 'started']),
          observedAt: z.string(),
        })
        .nullable(),
      next: EffectiveNetwork.nullable(),
      changedForNext: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
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
export function TaskRecovery({
  taskId,
  onNetwork,
}: {
  taskId: string;
  onNetwork?: (agentId: string) => void;
}) {
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
          {value.network && (
            <section aria-label="本轮网络设置">
              <h4>本轮网络</h4>
              <p>
                {value.network.current
                  ? `${value.network.current.state === 'started' ? '启动时已传入' : '准备启动，尚未确认进程'} · ${value.network.current.effective.mode === 'proxy' ? value.network.current.effective.proxyUrl : value.network.current.effective.mode === 'direct' ? '请求直接连接' : '保留成员原有设置'}`
                  : '此轮尚无网络设置记录，不以当前配置补写历史。'}
              </p>
              {value.network.changedForNext && (
                <p>
                  网络配置已更新，下次启动使用：
                  {value.network.next?.mode === 'proxy'
                    ? value.network.next.proxyUrl
                    : value.network.next?.mode === 'direct'
                      ? '直接连接'
                      : '成员原有设置'}
                  。当前执行保持原样。
                </p>
              )}
              {value.network.error && <p role="status">{value.network.error}</p>}
              {(value.network.next?.agentId || value.network.current?.agentId) && onNetwork && (
                <button
                  type="button"
                  onClick={() =>
                    onNetwork(value.network!.next?.agentId ?? value.network!.current!.agentId)
                  }
                >
                  打开此成员代理设置
                </button>
              )}
              {value.network.current && (
                <details>
                  <summary>应用范围与观察</summary>
                  <p>
                    观察于 {new Date(value.network.current.observedAt).toLocaleString('zh-CN')} ·
                    配置版本 {value.network.current.effective.revision} ·{' '}
                    {value.network.current.effective.source === 'member'
                      ? '成员单独设置'
                      : value.network.current.effective.source === 'global'
                        ? '跟随全局'
                        : '保留原有行为'}
                  </p>
                  <p>
                    环境设置在启动边界传入；未把它当作成员全部实际流量已被代理的证据。自动审批与人工合并不变。
                  </p>
                </details>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
