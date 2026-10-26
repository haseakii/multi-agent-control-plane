import { useId, useRef, useState } from 'react';
import { z } from 'zod';
import { Plus, ArrowRight } from 'lucide-react';
import s from './agent-connections.module.css';
const Receipt = z.object({
  member: z.object({ definition: z.object({ id: z.string() }) }),
  message: z.string(),
  ready: z.boolean(),
  reused: z.boolean(),
});
export function AgentMemberCreate({
  endpoint,
  defaultName,
  disabled,
  onCreated,
  onBusy,
}: {
  endpoint: string;
  defaultName: string;
  disabled?: boolean;
  onCreated: (id: string, message: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(defaultName),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const key = useRef({ name: '', id: crypto.randomUUID() }),
    flight = useRef(false),
    inputId = useId();
  async function create() {
    if (flight.current || !name.trim()) return;
    flight.current = true;
    setBusy(true);
    onBusy?.(true);
    setError('');
    const value = name.trim();
    if (key.current.name !== value) key.current = { name: value, id: crypto.randomUUID() };
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: key.current.id, name: value }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '成员创建尚未确认，请重试或刷新列表。');
      const receipt = Receipt.parse(data);
      setOpen(false);
      onCreated(receipt.member.definition.id, receipt.message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '成员创建尚未确认，请重试。');
    } finally {
      flight.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }
  if (!open)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setName(defaultName);
          setError('');
          key.current = { name: '', id: crypto.randomUUID() };
        }}
      >
        <Plus size={14} />
        使用现有程序创建成员
      </button>
    );
  return (
    <section className={s.memberCreate} aria-label="使用现有程序创建成员">
      <strong>复用程序，创建另一位成员</strong>
      <label className={s.field} htmlFor={inputId}>
        成员名称
        <input
          id={inputId}
          autoFocus
          value={name}
          maxLength={128}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 页面开发、代码检查"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void create();
            }
          }}
        />
      </label>
      <p className={s.hint}>
        不重复下载或安装。新成员分别设置模型和代理，默认作为普通协作者。账号由 ACP
        自身管理，复用程序可能共享其默认登录；不会复制凭据。
      </p>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.actions}>
        <button type="button" disabled={busy || !name.trim()} onClick={() => void create()}>
          <ArrowRight size={14} />
          {busy ? '正在创建并检查连接…' : '创建并打开成员'}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </section>
  );
}
