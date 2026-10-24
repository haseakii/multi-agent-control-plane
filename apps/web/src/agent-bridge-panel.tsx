import { useEffect, useState } from 'react';
import type { Snapshot } from './view-model';
import { api } from './http';

const permissions = [
  ['boss.orchestration', '编排与分派任务（需 Boss 资格）'],
  ['agent.messaging', '向其他 Agent 发送协作消息'],
  ['task.status', '查看和等待授权范围内的任务'],
  ['artifact.read', '读取授权范围内的产物'],
  ['artifact.publish', '发布任务产物'],
  ['knowledge.read', '检索当前项目的已采纳记忆和文本产物摘要'],
  ['memory.propose', '提交项目记忆提案（仍需人工采纳）'],
] as const;

export function AgentBridgePanel({
  agent,
  onSaved,
}: {
  agent: Snapshot['agents'][number]['definition'];
  onSaved: () => Promise<void>;
}) {
  const [scopes, setScopes] = useState(agent.controlBridge.scopes);
  const [canBeBoss, setCanBeBoss] = useState(agent.orchestration.canBeBoss);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const savedScopes = agent.controlBridge.scopes.join(',');
  useEffect(() => {
    setScopes(agent.controlBridge.scopes);
    setCanBeBoss(agent.orchestration.canBeBoss);
  }, [agent.id, savedScopes, agent.orchestration.canBeBoss]);
  async function save() {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await api('/api/agents/' + encodeURIComponent(agent.id), {
        method: 'PATCH',
        body: JSON.stringify({
          controlBridge: { transport: scopes.length ? 'mcp' : 'none', scopes },
          orchestration: { ...agent.orchestration, canBeBoss },
        }),
      });
      setNotice('权限已保存。新增工具在后续执行会话中提供；不会自动启动 Agent。');
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="technical-details agent-bridge-panel">
      <summary>Boss 资格与协作权限</summary>
      <p className="section-note">
        Boss 与 Worker
        可分别授权。知识检索可读取当前项目的文本产物摘要；完整产物读取仍受任务权限约束。项目策略还可进一步限制这些操作。
      </p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={canBeBoss}
          disabled={busy}
          onChange={(event) => {
            setCanBeBoss(event.target.checked);
            if (!event.target.checked)
              setScopes(scopes.filter((scope) => scope !== 'boss.orchestration'));
          }}
        />
        允许作为 Boss 候选（还需编排权限，并在项目中选择）
      </label>
      {permissions.map(([scope, label]) => (
        <label key={scope} className="checkbox-label">
          <input
            type="checkbox"
            checked={scopes.includes(scope)}
            disabled={busy || (scope === 'boss.orchestration' && !canBeBoss)}
            onChange={(event) =>
              setScopes(
                event.target.checked
                  ? [...scopes, scope]
                  : scopes.filter((value) => value !== scope),
              )
            }
          />
          {label}
        </label>
      ))}
      <button type="button" disabled={busy} onClick={() => void save()}>
        保存协作权限
      </button>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
