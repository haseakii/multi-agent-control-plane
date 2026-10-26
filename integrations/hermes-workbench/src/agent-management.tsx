import { useRef, useState } from 'react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import { memberActionRequest } from './member-action-request';
import { removeAgentWithRecovery, saveAgentWithRecovery } from './agent-save-recovery';
import {
  AgentConnection,
  configurationError,
  ensureAgentIdle,
  type AgentConnectionData,
} from './agent-config';
import s from './agent-connections.module.css';

const Removal = z.object({
  agentId: z.string(),
  name: z.string(),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  canRemove: z.boolean(),
  blockers: z.array(z.string()),
  references: z.array(z.object({ kind: z.string(), count: z.number().int().positive() })),
});
const referenceLabels: Record<string, string> = {
  project: '项目默认负责人',
  'boss-assignment': '负责人记录',
  task: '任务',
  assignment: '任务分派',
  conversation: '执行会话',
  message: '协作消息',
  delivery: '消息投递',
  artifact: '产物',
  approval: '审批',
  event: '审计记录',
  memory: '项目记忆',
};

export function AgentManagement({
  agent,
  disabled,
  active = false,
  onEdit,
  onChanged,
  onBusy,
}: {
  agent: AgentConnectionData;
  disabled: boolean;
  active?: boolean;
  onEdit: () => void;
  onChanged: (notice: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<z.infer<typeof Removal>>();
  const url = `/api/agents/${encodeURIComponent(agent.definition.id)}`;
  const readMembers = (signal: AbortSignal) =>
    fetchJSON('/api/agents', { signal }, z.array(AgentConnection));
  const readRemoval = () =>
    memberActionRequest('management', (signal) => fetchJSON(`${url}/removal`, { signal }, Removal));
  async function run(action: () => Promise<void>, requireIdle = true) {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    setChecking(false);
    try {
      if (requireIdle)
        await memberActionRequest('management', (signal) =>
          ensureAgentIdle(agent.definition.id, signal),
        );
      await action();
    } catch (failure) {
      setError(configurationError(failure));
      setPreview(undefined);
      onChanged('已请求刷新成员状态，请核对后再操作。');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setChecking(false);
      onBusy(false);
    }
  }
  async function toggle() {
    await run(async () => {
      const updated = await saveAgentWithRecovery(
        { ...agent.definition, enabled: !agent.definition.enabled },
        (signal) =>
          fetchJSON(
            url,
            {
              method: 'PATCH',
              signal,
              body: JSON.stringify({
                enabled: !agent.definition.enabled,
                ...(agent.definitionHash ? { expectedDefinitionHash: agent.definitionHash } : {}),
              }),
            },
            AgentConnection,
          ),
        readMembers,
        () => setChecking(true),
      );
      setPreview(undefined);
      onChanged(
        updated.definition.enabled
          ? `${updated.definition.name} 已启用，请检查连接以恢复就绪状态。`
          : `${updated.definition.name} 已停用，历史任务和结果仍保留。`,
      );
    }, !agent.definition.enabled);
  }
  const lock = disabled || busy;
  return (
    <div className={s.management}>
      <div className={s.actions}>
        <button type="button" disabled={lock} onClick={onEdit}>
          编辑配置
        </button>
        <button
          type="button"
          disabled={
            lock ||
            (!agent.definition.enabled &&
              (active || agent.localEntry?.offlineChecksPassed !== true))
          }
          onClick={() => void toggle()}
        >
          {agent.definition.enabled ? '停用成员' : '启用成员'}
        </button>
        <button
          type="button"
          disabled={lock || active}
          onClick={() =>
            void run(async () => {
              setPreview(await readRemoval());
            })
          }
        >
          检查能否移除
        </button>
      </div>
      {active && (
        <p className={s.hint}>执行期间仍可停用成员或编辑以收回权限；启用和移除需等任务结束。</p>
      )}
      {!agent.definition.enabled && agent.localEntry?.offlineChecksPassed !== true && (
        <p className={s.hint}>启动入口检查尚未通过，请先编辑配置，确认本机路径有效。</p>
      )}
      {preview && (
        <div className={s.removal}>
          <strong>移除 {preview.name} 的注册配置</strong>
          <p>仅移除操作台登记，不删除已安装软件、登录状态或工作目录。</p>
          {preview.blockers.includes('enabled') && <p>请先停用此成员，再重新检查。</p>}
          {preview.blockers.includes('observation-in-progress') && (
            <p>连接检查或登录仍在进行，请完成后重试。</p>
          )}
          {preview.references.length > 0 && (
            <>
              <p>已有记录引用此成员，请保留注册并停用：</p>
              <ul>
                {preview.references.map((reference) => (
                  <li key={reference.kind}>
                    {referenceLabels[reference.kind] ?? reference.kind}：{reference.count}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className={s.actions}>
            <button type="button" disabled={lock} onClick={() => setPreview(undefined)}>
              取消
            </button>
            <button
              type="button"
              disabled={lock || active}
              onClick={() =>
                void run(async () => {
                  setPreview(await readRemoval());
                })
              }
            >
              重新检查
            </button>
            <button
              type="button"
              disabled={lock || active || !preview.canRemove}
              onClick={() =>
                void run(async () => {
                  await removeAgentWithRecovery(
                    preview.agentId,
                    (signal) =>
                      fetchJSON(
                        url,
                        {
                          method: 'DELETE',
                          signal,
                          body: JSON.stringify({
                            confirmedAgentId: preview.agentId,
                            definitionHash: preview.definitionHash,
                          }),
                        },
                        z.object({ removed: z.literal(true), agentId: z.string() }),
                      ),
                    readMembers,
                    () => setChecking(true),
                  );
                  onChanged(`${preview.name} 的注册配置已移除。`);
                })
              }
            >
              确认移除注册
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {checking && (
        <p role="status" className={s.hint}>
          正在核对服务端是否已完成操作；不会重复提交。
        </p>
      )}
    </div>
  );
}
