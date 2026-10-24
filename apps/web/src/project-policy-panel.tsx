import { useEffect, useState } from 'react';
import {
  ProjectToolActionSchema,
  type ProjectPolicy,
} from '../../../packages/core/src/project-policy';
import { api } from './http';
const labels = [
  '发现 Agent',
  '查看 Agent',
  '创建子任务',
  '分派任务',
  '查看任务',
  '等待任务',
  '跨 Agent 消息',
  '发布产物',
  '读取产物',
  '提出审批请求',
  '取消任务',
  '检索项目知识',
  '提交记忆提案',
];
export function ProjectPolicyPanel({ projectId }: { projectId: string }) {
  const [policy, setPolicy] = useState<ProjectPolicy>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const path = '/api/projects/' + encodeURIComponent(projectId) + '/policy';
  async function refresh() {
    setPolicy(await api<ProjectPolicy>(path));
    setNotice('');
  }
  useEffect(() => {
    void refresh().catch(() => setError('策略加载失败。'));
  }, [projectId]);
  async function save() {
    if (!policy || busy) return;
    setBusy(true);
    setError('');
    try {
      setPolicy(
        await api<ProjectPolicy>(path, {
          method: 'PUT',
          body: JSON.stringify({
            expectedRevision: policy.revision,
            tools: policy.tools,
            gitMerge: policy.gitMerge,
            gitPush: policy.gitPush,
            requireEnforcedExecution: policy.requireEnforcedExecution,
            agentPermissions: policy.agentPermissions,
          }),
        }),
      );
      setNotice('已保存，后续受控操作按新规则检查。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="execution-context-panel">
      <summary>项目策略{policy ? ' · 版本 ' + policy.revision : ''}</summary>
      <p className="section-note">
        以下规则限制经过控制平面的操作；Agent
        自有工具和操作系统访问不受这些开关拦截。修改不会撤回已执行的操作。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {policy ? (
        <>
          {ProjectToolActionSchema.options.map((action, index) => (
            <label key={action} style={{ display: 'block', margin: '8px 0' }}>
              <input
                type="checkbox"
                disabled={busy}
                checked={policy.tools[action] !== 'deny'}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    tools: { ...policy.tools, [action]: event.target.checked ? 'allow' : 'deny' },
                  })
                }
              />
              允许{labels[index]}
            </label>
          ))}
          <label style={{ display: 'block', margin: '12px 0' }}>
            <input
              type="checkbox"
              disabled={busy}
              checked={policy.gitMerge === 'ask'}
              onChange={(event) =>
                setPolicy({ ...policy, gitMerge: event.target.checked ? 'ask' : 'deny' })
              }
            />
            允许申请本地合并（仍需人工批准具体快照）
          </label>
          <label style={{ display: 'block', margin: '12px 0' }}>
            <input
              type="checkbox"
              disabled={busy}
              checked={policy.gitPush === 'ask'}
              onChange={(event) =>
                setPolicy({ ...policy, gitPush: event.target.checked ? 'ask' : 'deny' })
              }
            />
            允许申请 Git 推送（仍需人工批准提交和远端地址）
          </label>
          <label style={{ display: 'block', margin: '12px 0' }}>
            <input
              type="checkbox"
              disabled={busy}
              checked={policy.requireEnforcedExecution}
              onChange={(event) =>
                setPolicy({ ...policy, requireEnforcedExecution: event.target.checked })
              }
            />
            要求操作系统级隔离（当前 LocalRunner 将拒绝启动新执行）
          </label>
          <button disabled={busy} onClick={() => void save()}>
            保存项目策略
          </button>
        </>
      ) : null}
      <button disabled={busy} onClick={() => void refresh().catch(() => setError('刷新失败。'))}>
        重新加载策略
      </button>
    </details>
  );
}
