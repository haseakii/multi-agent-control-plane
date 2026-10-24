import type { Snapshot } from './view-model';
type Agent = Snapshot['agents'][number];
export function AgentConnectionDetails({ agent }: { agent: Agent }) {
  const connection =
    agent.readiness.runtime === 'ready'
      ? '可连接（initialize）'
      : agent.readiness.runtime === 'error'
        ? '连接失败'
        : '未探针';
  const authentication =
    (
      {
        unknown: '未知；探针不代表已登录',
        needs_login: '需要登录',
        ready: '认证请求已完成；未验证模型',
        not_reported: 'Agent 未报告认证状态',
      } as Record<string, string>
    )[agent.readiness.auth] ?? agent.readiness.auth;
  return (
    <div className="agent-connection-details">
      <dl className="agent-state-grid">
        <dt>启用状态</dt>
        <dd>{agent.definition.enabled ? '已启用（不会自动提交任务）' : '未启用'}</dd>
        <dt>本机入口</dt>
        <dd>
          {agent.localEntry
            ? agent.localEntry.offlineChecksPassed
              ? '文件校验通过；版本/来源未验证'
              : '文件校验未通过'
            : '未做本机文件校验'}
        </dd>
        <dt>ACP 连接</dt>
        <dd>{connection}</dd>
        <dt>认证</dt>
        <dd>{authentication}</dd>
        <dt>模型执行</dt>
        <dd>initialize 不验证模型执行；任务结果另见工作区</dd>
        <dt>Boss 配置</dt>
        <dd>
          {agent.definition.orchestration.canBeBoss
            ? '配置允许；仍需任务权限及桥接验证'
            : '未配置为 Boss'}
        </dd>
        <dt>最近探针</dt>
        <dd>
          {agent.negotiation
            ? (agent.readiness.observedAt ?? '检查时间未报告')
            : '尚无成功协商记录'}
        </dd>
      </dl>
      <details className="technical-details">
        <summary>入口、协商与权限详情</summary>
        <p>本机路径及参数（用户配置）：</p>
        <pre>{JSON.stringify(agent.definition.runtime, null, 2)}</pre>
        {agent.localEntry?.issues.map((issue) => (
          <p className="inline-error" key={issue.code}>
            {issue.code}：{issue.message}
          </p>
        ))}
        <p>
          配置的 Fleet MCP：{agent.definition.controlBridge.transport}；scopes：
          {agent.definition.controlBridge.scopes.join('、') || '无'}。
        </p>
        <p>
          这是配置范围，不是当前授权凭证；不会默认传入外部 MCP。Agent
          自有工具不受此展示全面拦截，LocalRunner 不是 OS 沙箱。
        </p>
        <p>Auth methods（目录不登录；terminal 方法需真实交互终端）：</p>
        <pre>{JSON.stringify(agent.authMethods, null, 2)}</pre>
        <p>ACP 协商能力（自报；扩展值脱敏并限制长度，不证明模型可用）：</p>
        <pre>
          {agent.negotiation
            ? JSON.stringify(agent.negotiation, null, 2)
            : '未探针或最近探针失败；无可用协商信息。'}
        </pre>
      </details>
    </div>
  );
}
