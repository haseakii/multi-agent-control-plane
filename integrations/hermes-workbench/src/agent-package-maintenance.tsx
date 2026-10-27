import { useState } from 'react';
import { z } from 'zod';
import s from './agent-connections.module.css';

const Preview = z.object({
  installationId: z.string(),
  action: z.enum(['history', 'uninstall']),
  planHash: z.string(),
  paths: z.array(z.string()),
  bytes: z.number(),
  files: z.number(),
  members: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
  blockers: z.array(z.string()),
  canApply: z.boolean(),
});
const Receipt = z.object({ message: z.string() });
async function request<S extends z.ZodType>(url: string, schema: S, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '操作未确认，请刷新后重新预览。');
  return schema.parse(data);
}

export function AgentPackageMaintenance({
  id,
  disabled,
  uninstalled,
  onChanged,
  onBusy,
}: {
  id: string;
  disabled: boolean;
  uninstalled: boolean;
  onChanged: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<z.infer<typeof Preview>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function preview(action: 'history' | 'uninstall') {
    setBusy(true);
    onBusy(true);
    setError('');
    setMessage('');
    setPlan(undefined);
    try {
      setPlan(
        await request(`/api/agent-installations/${id}/maintenance-preview`, Preview, { action }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '预览未完成。');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  async function apply() {
    if (!plan || busy) return;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const result = await request(`/api/agent-installations/${id}/maintenance`, Receipt, {
        action: plan.action,
        planHash: plan.planHash,
        confirmed: true,
      });
      setMessage(result.message);
      setPlan(undefined);
      await onChanged();
    } catch (failure) {
      setPlan(undefined);
      setError(failure instanceof Error ? failure.message : '操作未确认，请刷新后重新预览。');
      await onChanged().catch(() => {});
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div className={s.installPanel} aria-label="程序维护">
      <div className={s.actions}>
        <button type="button" disabled={disabled || busy} onClick={() => void preview('history')}>
          清理历史下载
        </button>
        {!uninstalled && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void preview('uninstall')}
          >
            卸载程序
          </button>
        )}
      </div>
      {busy && <p role="status">正在检查或清理文件，请稍候…</p>}
      {plan && (
        <section aria-label={plan.action === 'uninstall' ? '确认卸载程序' : '确认清理历史下载'}>
          <p>
            {plan.action === 'uninstall'
              ? '将删除此安装记录的程序及下载文件。关联成员需先停用；成员配置、任务历史、共享运行环境和登录目录保留。'
              : '仅清理旧安装尝试和下载缓存，保留当前程序及其他成员使用的文件。'}
          </p>
          <p>
            涉及 {plan.paths.length} 个位置、{plan.files} 个文件，约{' '}
            {(plan.bytes / 1024 / 1024).toFixed(1)} MB。
          </p>
          {plan.members.length > 0 && (
            <p>
              关联成员：
              {plan.members
                .map((member) => member.name + (member.enabled ? '（启用中）' : '（已停用）'))
                .join('、')}
            </p>
          )}
          <details>
            <summary>查看清理位置</summary>
            <pre className={s.configExample}>{plan.paths.join('\n') || '没有待删除文件'}</pre>
          </details>
          {plan.blockers.map((blocker) => (
            <p className={s.error} role="alert" key={blocker}>
              {blocker}
            </p>
          ))}
          {!plan.canApply && !plan.blockers.length && <p role="status">没有可清理的内容。</p>}
          <div className={s.actions}>
            <button
              type="button"
              disabled={disabled || busy || !plan.canApply}
              onClick={() => void apply()}
            >
              {plan.action === 'uninstall' ? '确认卸载' : '确认清理'}
            </button>
            <button type="button" disabled={busy} onClick={() => setPlan(undefined)}>
              取消
            </button>
          </div>
        </section>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
