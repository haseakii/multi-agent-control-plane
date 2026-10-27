import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { AgentConnection, ensureAgentIdle } from './agent-config';
import { memberActionRequest } from './member-action-request';
import s from './agent-connections.module.css';

export const InstalledMember = z.object({
  connectionOperation: z.enum(['probe', 'auth']).optional(),
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(false),
  readiness: z
    .object({
      runtime: z.enum(['unknown', 'ready', 'error']),
      auth: z.enum(['unknown', 'ready', 'needs_login', 'not_reported']),
    })
    .optional(),
  authMethods: z
    .array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() }))
    .default([]),
});

export function AgentInstallMember({
  member,
  onUse,
  onExisting,
  disabled = false,
}: {
  member: z.infer<typeof InstalledMember>;
  onUse: (id: string) => void;
  onExisting: (id?: string) => void;
  disabled?: boolean;
}) {
  const [updated, setUpdated] = useState<z.infer<typeof InstalledMember>>();
  const [pending, setPending] = useState<'probe' | 'auth'>(),
    flight = useRef(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => setUpdated(undefined), [JSON.stringify(member)]);
  const current = updated ?? member;
  const operation = pending ?? member.connectionOperation;
  const busy = !!operation;
  const methods = current.authMethods.filter(
    (method) => !method.type || ['agent', 'terminal'].includes(method.type),
  );
  const [methodId, setMethodId] = useState('');
  const method = methods.find((item) => item.id === methodId) ?? methods[0];
  const ready =
    current.enabled &&
    current.readiness?.runtime === 'ready' &&
    ['ready', 'not_reported'].includes(current.readiness.auth);
  async function act(auth: boolean) {
    if (disabled || busy || flight.current || (auth && !method)) return;
    flight.current = true;
    setPending(auth ? 'auth' : 'probe');
    setError('');
    let use = false;
    try {
      await memberActionRequest('activity', (signal) => ensureAgentIdle(current.id, signal));
      const next = await memberActionRequest(auth ? 'auth' : 'probe', (signal) =>
        fetchJSON(
          `/api/agents/${encodeURIComponent(current.id)}/${auth ? 'auth' : 'probe'}`,
          { method: 'POST', body: JSON.stringify(auth ? { methodId: method!.id } : {}), signal },
          AgentConnection,
        ),
      );
      if (!alive.current) return;
      const result = {
        id: next.definition.id,
        name: next.definition.name,
        enabled: next.definition.enabled,
        readiness: next.readiness,
        authMethods: next.authMethods,
      };
      setUpdated(result);
      use =
        auth &&
        result.enabled &&
        result.readiness.runtime === 'ready' &&
        result.readiness.auth === 'ready';
      if (auth && !use) setError('登录尚未确认，保留当前页面。可重新检查或打开成员查看详情。');
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : '登录或连接尚未完成，请重试。');
    } finally {
      flight.current = false;
      if (alive.current) setPending(undefined);
    }
    if (use && alive.current) onUse(current.id);
  }
  return (
    <section className={s.installMember} aria-label={`${current.name} 安装后使用`}>
      <strong>{current.name}</strong>
      <p>
        {busy
          ? operation === 'auth'
            ? '请在成员打开的窗口中完成登录；可以关闭面板，后台继续等待登录结果。'
            : '正在检查此成员的连接；可以关闭面板或操作其他成员。'
          : ready
            ? current.readiness?.auth === 'not_reported'
              ? '程序已就绪；此成员不报告登录状态，可直接使用。'
              : '安装与登录已就绪，可以直接使用。'
            : current.readiness?.runtime === 'ready'
              ? '安装已完成，接下来登录你的成员账号。'
              : '安装已完成，检查连接后继续登录。'}
      </p>
      <div className={s.actions}>
        {ready ? (
          <button
            type="button"
            className={s.primary}
            disabled={disabled || busy}
            onClick={() => onUse(current.id)}
          >
            使用此成员
          </button>
        ) : current.readiness?.runtime === 'ready' && method ? (
          <>
            {methods.length > 1 && (
              <select
                aria-label={`${current.name} 登录方式`}
                value={method.id}
                disabled={disabled || busy}
                onChange={(event) => setMethodId(event.target.value)}
              >
                {methods.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={s.primary}
              disabled={disabled || busy || !current.enabled}
              onClick={() => void act(true)}
            >
              {busy
                ? '等待登录完成…'
                : method.type === 'terminal'
                  ? '在终端登录并使用'
                  : '登录并使用'}
            </button>
          </>
        ) : (
          <button type="button" disabled={disabled || busy} onClick={() => void act(false)}>
            检查连接
          </button>
        )}
        <button type="button" disabled={disabled || busy} onClick={() => onExisting(current.id)}>
          成员详情
        </button>
      </div>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </section>
  );
}
