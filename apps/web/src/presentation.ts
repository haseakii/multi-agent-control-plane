import type { Snapshot } from './view-model';

const taskStates: Record<string, string> = {
  draft: '草稿',
  planning: '规划中',
  ready: '待执行',
  running: '执行中',
  waiting: '等待中',
  waiting_approval: '待审批',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const approvalStates: Record<string, string> = {
  pending: '待决定',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
};
const events: Record<string, string> = {
  'boss.selected': '已选择总控 Agent',
  'agents.discovered': '已发现可用 Agent',
  'task.created': '已创建任务',
  'task.delegated': '已委派任务',
  'task.state_changed': '任务状态已更新',
  'task.dependencies_changed': '任务依赖已更新',
  'task.retry_requested': '已请求恢复执行',
  'task.cancelled': '任务已取消',
  'worker.completed': '执行者已完成',
  'boss.completed': '总控已完成汇总',
  'assignment.created': '已分配执行者',
  'attempt.created': '已创建执行尝试',
  'attempt.started': '已开始执行',
  'attempt.finished': '执行尝试已结束',
  'attempt.interrupted': '执行被中断',
  'execution.started': '已开始执行',
  'execution.completed': '执行已完成',
  'execution.failed': '执行失败',
  'approval.requested': '等待审批决定',
  'approval.decided': '审批已决定',
  'message.queued': '消息已排队',
  'message.claimed': '消息已领取',
  'message.delivered': '消息已送达',
  'fleet.tool': 'Agent 工具调用',
  'workspace.push.prepared': '已生成推送申请',
  'workspace.cleanup.removing': '正在清理任务工作区',
  'workspace.cleanup.completed': '任务工作区已清理',
  'workspace.cleanup.failed': '工作区清理待核对',
  'workspace.push.approved': '推送目标已批准',
  'workspace.push.rejected': '推送已拒绝',
  'workspace.push.started': '已开始推送',
  'workspace.push.pushed': '已推送审阅提交',
  'workspace.push.failed': '推送结果未确认',
  'workspace.push.reconciled': '已核对推送成功',
  'workspace.push.checked': '已核对远端分支',
};
// Exact known values only: unknown protocol values remain visible verbatim.
const knownLabel = (labels: Record<string, string>, value: string): string =>
  Object.hasOwn(labels, value) ? labels[value]! : value;
export const taskStateLabel = (value: string): string => knownLabel(taskStates, value);
export const approvalStateLabel = (value: string): string => knownLabel(approvalStates, value);
export const eventLabel = (value: string): string => knownLabel(events, value);
export const outcomeLabel = (value: string): string =>
  knownLabel({ failed: '失败', denied: '已拒绝' }, value);
export function agentLabel(id: string | undefined, snapshot: Snapshot | null): string {
  return id === undefined
    ? '未分配执行者'
    : (snapshot?.agents.find((agent) => agent.definition.id === id)?.definition.name ?? id);
}

export function actorLabel(
  actor: { id: string; type?: string },
  snapshot: Snapshot | null,
): string {
  if (actor.type === 'agent') return `Agent · ${agentLabel(actor.id, snapshot)}`;
  if (actor.type === 'system') return `系统 · ${actor.id}`;
  if (actor.type === 'user') return `用户 · ${actor.id}`;
  return actor.type === undefined ? actor.id : `${actor.type} · ${actor.id}`;
}
