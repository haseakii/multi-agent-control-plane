import { useRef, useState } from 'react';
import type {
  AgentRemovalPreview,
  AgentReferenceCount,
} from '../../../packages/core/src/agent-lifecycle';
import { api } from './http';

const referenceNames: Record<AgentReferenceCount['kind'], string> = {
  project: '项目默认 Boss',
  'boss-assignment': 'Boss 任职记录',
  task: '任务',
  assignment: '任务分派',
  conversation: '执行会话',
  message: '协作消息',
  delivery: '消息投递',
  artifact: '产物',
  approval: '审批',
  event: '审计事件',
  memory: '项目记忆',
};

export function AgentRemovalPanel({
  agentId,
  onRemoved,
}: {
  agentId: string;
  onRemoved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<AgentRemovalPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = '/api/agents/' + encodeURIComponent(agentId);
  async function inspect() {
    setBusy(true);
    setError('');
    try {
      setPreview(await api<AgentRemovalPreview>(path + '/removal'));
      dialog.current?.showModal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '检查失败。');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!preview?.canRemove || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(path, {
        method: 'DELETE',
        body: JSON.stringify({
          confirmedAgentId: preview.agentId,
          definitionHash: preview.definitionHash,
        }),
      });
      dialog.current?.close();
      await onRemoved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除失败。');
      setPreview(await api<AgentRemovalPreview>(path + '/removal').catch(() => undefined));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="agent-removal-panel">
      <button ref={trigger} type="button" disabled={busy} onClick={() => void inspect()}>
        移除注册项
      </button>
      {error && !dialog.current?.open ? <p role="alert">{error}</p> : null}
      <dialog
        ref={dialog}
        className="agent-removal-dialog"
        aria-label="移除 Agent 注册项"
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <h3>移除 Agent 注册项</h3>
        {preview ? (
          <>
            <p>
              <strong>{preview.name}</strong>（{preview.agentId}）
            </p>
            <p>
              将删除操作台保存的启动配置和协作权限。Agent
              软件、登录状态和工作目录不会被删除。需要时可重新注册。
            </p>
            {preview.blockers.includes('enabled') ? <p>请先关闭此 Agent 的启用开关。</p> : null}
            {preview.blockers.includes('observation-in-progress') ? (
              <p>连接检查或认证仍在进行，请结束后重新检查。</p>
            ) : null}
            {preview.references.length ? (
              <>
                <p>
                  以下记录仍引用此 Agent。已执行过任务的 Agent 请保留注册项并停用；仅被选为默认 Boss
                  的 Agent 可在项目中取消选择。
                </p>
                <ul>
                  {preview.references.map((item) => (
                    <li key={item.kind}>
                      {referenceNames[item.kind]}：{item.count}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="memory-actions">
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            取消
          </button>
          <button type="button" disabled={busy} onClick={() => void inspect()}>
            重新检查
          </button>
          <button
            type="button"
            disabled={busy || !preview?.canRemove}
            onClick={() => void remove()}
          >
            {busy ? '处理中…' : '确认移除注册项'}
          </button>
        </div>
      </dialog>
    </div>
  );
}
