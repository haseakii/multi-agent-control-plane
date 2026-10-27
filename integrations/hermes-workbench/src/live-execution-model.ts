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

export function executionCardSummary({
  state,
  durationMs,
  collaboratorsCount,
  stepCount,
}: {
  state: string;
  durationMs: number;
  collaboratorsCount: number;
  stepCount: number;
}): {
  status: 'completed' | 'failed' | 'blocked';
  icon: string;
  text: string;
} {
  const isCancelled = state === 'cancelled';
  const isFailed = state === 'failed';
  const isBlocked = state === 'blocked';
  const isCompleted = state === 'completed';

  const status: 'completed' | 'failed' | 'blocked' =
    isCancelled || isFailed ? 'failed' : isBlocked ? 'blocked' : 'completed';
  const icon = isCancelled || isFailed ? '⚠️' : isBlocked ? '⏸' : '⚡';

  const text = isCompleted
    ? `本轮执行完毕 · 耗时 ${formatDuration(durationMs)} · ${collaboratorsCount} 个协作者 · ${stepCount} 项步骤`
    : isCancelled
      ? `本轮已取消 · 耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`
      : isFailed
        ? `本轮执行失败 · 耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`
        : isBlocked
          ? `任务已暂停 · 已耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`
          : `本轮状态（${stateLabel(state)}） · 耗时 ${formatDuration(durationMs)} · ${stepCount} 项步骤`;

  return { status, icon, text };
}
