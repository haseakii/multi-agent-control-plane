export type ExecutionMode = 'direct' | 'collaborative';
export interface Member {
  definition: {
    enabled: boolean;
    orchestration: { canBeBoss: boolean };
    controlBridge: { transport: string; scopes: string[] };
  };
  readiness: { runtime: string; auth: string };
}

export function memberUnavailableReason(member: Member | undefined, mode: ExecutionMode) {
  if (!member) return { label: '成员已不在列表中', detail: '请重新选择成员；原任务草稿仍保留。' };
  const { definition: d, readiness: r } = member;
  if (!d.enabled) return { label: '已停用', detail: '在成员卡片启用后，再检查连接。' };
  if (r.runtime === 'error')
    return { label: '连接失败', detail: '查看此成员的诊断，修正启动入口后重新检查连接。' };
  if (r.runtime !== 'ready')
    return { label: '尚未确认连接', detail: '先检查此成员的 ACP 连接，再根据返回状态确认登录。' };
  if (!['ready', 'not_reported'].includes(r.auth))
    return {
      label: r.auth === 'needs_login' ? '需要登录' : '登录待确认',
      detail: '在此成员卡片完成登录确认，由 Agent 自己管理授权。',
    };
  if (mode === 'collaborative') {
    if (!d.orchestration.canBeBoss)
      return {
        label: '未启用负责人角色',
        detail: '此成员可以直接执行任务。安排协作需要启用负责人角色和编排接口。',
      };
    if (
      d.controlBridge.transport !== 'mcp' ||
      !d.controlBridge.scopes.includes('boss.orchestration')
    )
      return {
        label: '编排接口未接通',
        detail: '此成员可以直接执行任务。安排协作需要支持 MCP 并配置编排权限。',
      };
  }
  return undefined;
}
export function selectableAgents<T extends Member>(agents: T[], mode: ExecutionMode): T[] {
  return agents.filter((agent) => !memberUnavailableReason(agent, mode));
}

/** Saved readiness must not bypass an unfinished or failed entry repair. */
export function usableOnboardingMember<T extends Member>(row: {
  done?: boolean;
  error?: string;
  saved?: T;
  existing?: T;
}): T | undefined {
  if (!row.done || row.error) return undefined;
  const member = row.saved ?? row.existing;
  return member && !memberUnavailableReason(member, 'direct') ? member : undefined;
}
