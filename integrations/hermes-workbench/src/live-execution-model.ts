export function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    draft: '草稿',
    created: '已创建',
    ready: '就绪',
    waiting: '等待中',
    waiting_children: '等待协作',
    running: '执行中',
    blocked: '已暂停',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消',
  };
  return labels[state] ?? state;
}

export function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '0秒';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 1) return '<1秒';
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) {
    return `${hours}小时${remainingMinutes > 0 ? `${remainingMinutes}分` : ''}`;
  }
  return `${minutes}分${seconds > 0 ? `${seconds}秒` : ''}`;
}

export function formatTimer(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function extractStepTarget(title: string): string | undefined {
  if (!title || typeof title !== 'string') return undefined;
  // Match "Running tool_name: target" or "tool_name: target"
  const colonMatch = /^(?:Running\s+)?[\w.-]+[:]\s*(.+)$/i.exec(title);
  if (colonMatch?.[1]?.trim()) {
    return colonMatch[1].trim();
  }
  // Match "Running tool_name (target)" or "tool_name (target)"
  const parenMatch = /^(?:Running\s+)?[\w.-]+\s*\((.+)\)$/i.exec(title);
  if (parenMatch?.[1]?.trim()) {
    return parenMatch[1].trim();
  }
  return undefined;
}

export function stripStepTarget(title: string): string {
  if (!title || typeof title !== 'string') return title ?? '';
  return title
    .replace(/[:]\s*.+$/, '')
    .replace(/\s*\([^)]+\)$/, '')
    .trim();
}

export interface DelegationInfo {
  leaderName: string;
  workerName?: string;
  subtaskTitle?: string;
  hasDelegation: boolean;
}

export function resolveDelegation({
  snapshot,
  root,
  family,
}: {
  snapshot?: {
    agents: Array<{ definition: { id: string; name: string } }>;
    assignments: Array<{ id: string; taskId: string; agentId: string }>;
  };
  root: { id: string; ownerAgentId?: string };
  family: Array<{
    id: string;
    parentTaskId?: string;
    ownerAgentId?: string;
    title: string;
    state: string;
  }>;
}): DelegationInfo {
  const getAgentName = (agentId?: string) => {
    if (!agentId) return undefined;
    return snapshot?.agents.find((a) => a.definition.id === agentId)?.definition.name ?? agentId;
  };

  const getTaskAgentName = (task: { id: string; ownerAgentId?: string }) => {
    const fromOwner = getAgentName(task.ownerAgentId);
    if (fromOwner) return fromOwner;
    const assignment = snapshot?.assignments.filter((a) => a.taskId === task.id).at(-1);
    return getAgentName(assignment?.agentId) ?? '执行成员';
  };

  const leaderName = getTaskAgentName(root);

  // Look for active or recent child task
  const children = family.filter((t) => t.id !== root.id);
  if (children.length === 0) {
    return {
      leaderName,
      hasDelegation: false,
    };
  }

  // Find running or waiting child first, otherwise latest child
  const activeChild =
    children.find((t) => ['running', 'waiting', 'blocked', 'waiting_children'].includes(t.state)) ??
    children.at(-1);

  if (!activeChild) {
    return {
      leaderName,
      hasDelegation: false,
    };
  }

  const workerName = getTaskAgentName(activeChild);

  return {
    leaderName,
    workerName,
    subtaskTitle: activeChild.title,
    hasDelegation: workerName !== leaderName,
  };
}

export function executionCardSummary({
  state,
  durationMs,
  collaboratorsCount,
  stepCount,
  artifactsCount = 0,
  failureReason,
  delegation,
}: {
  state: string;
  durationMs: number;
  collaboratorsCount: number;
  stepCount: number;
  artifactsCount?: number;
  failureReason?: string;
  delegation?: DelegationInfo;
}): {
  status: 'completed' | 'failed' | 'blocked';
  icon: string;
  text: string;
  failureReason?: string;
  artifactsCount: number;
} {
  const isCancelled = state === 'cancelled';
  const isFailed = state === 'failed';
  const isBlocked = state === 'blocked';
  const isCompleted = state === 'completed';

  const status: 'completed' | 'failed' | 'blocked' =
    isCancelled || isFailed ? 'failed' : isBlocked ? 'blocked' : 'completed';
  const icon = isCancelled || isFailed ? '⚠️' : isBlocked ? '⏸' : '⚡';

  const delegationClause =
    delegation?.hasDelegation && delegation.workerName
      ? `（${delegation.leaderName} ➜ ${delegation.workerName}）`
      : '';

  const artifactClause = artifactsCount > 0 ? ` · ${artifactsCount} 个产物` : '';

  const text = isCompleted
    ? `本轮执行完毕 · 耗时 ${formatDuration(durationMs)} · ${collaboratorsCount} 个协作者${delegationClause} · ${stepCount} 项步骤${artifactClause}`
    : isCancelled
      ? `本轮已取消 · 耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`
      : isFailed
        ? `本轮执行失败 · 耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`
        : isBlocked
          ? `任务已暂停 · 已耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`
          : `本轮状态（${stateLabel(state)}） · 耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`;

  return { status, icon, text, failureReason, artifactsCount };
}
