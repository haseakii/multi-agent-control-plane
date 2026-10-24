import { failureSummary } from './failure-presentation';

const ended = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

export function executionEnded(attemptState?: string, taskState?: string) {
  // An exact attempt is authoritative; task state may already describe a retry.
  return ended.has(attemptState ?? taskState ?? '');
}

export function toolOutcome(toolState: string, attemptState?: string, taskState?: string) {
  if (toolState === 'failed') return 'error';
  if (toolState === 'completed') return 'done';
  return executionEnded(attemptState, taskState) ? 'unreported' : 'running';
}

const toolLabels: Record<string, string> = {
  view_file: '读取文件',
  edit_file: '修改文件',
  read_file: '读取文件',
  write_file: '写入文件',
  write_to_file: '写入文件',
  replace_file_content: '修改文件',
  multi_replace_file_content: '修改文件',
  list_dir: '查看目录',
  grep_search: '搜索文件内容',
  find_by_name: '查找文件',
  run_command: '运行命令',
  command_status: '查看命令状态',
  control_discover_agents: '查找协作成员',
  control_create_task: '创建协作任务',
  control_delegate_task: '委派协作任务',
  control_get_artifact: '读取协作产物',
  control_get_task: '查看任务状态',
  control_wait_for_task: '等待协作结果',
  control_wait_task: '等待协作结果',
  control_send_message: '发送协作消息',
  'Guardian Review': '检查操作权限',
};

export function toolPresentation(
  title: string,
  toolState: string,
  attemptState?: string,
  taskState?: string,
) {
  // Some adapters keep their initial "Running <tool>" title on completion.
  // Only recognize exact tool identifiers; never infer an outcome from prose.
  const identifier = /^(?:Running )?([\w.-]+)$/.exec(title)?.[1];
  const label = toolLabels[identifier?.split('.').at(-1) ?? title] ?? title;
  const reported = toolOutcome(toolState, attemptState, taskState);
  // ACP adapters may defer read outcomes until the entire turn ends. A read
  // notification is not evidence that the file is still being read now.
  const outcome =
    reported === 'running' &&
    toolState === 'in_progress' &&
    ['view_file', 'read_file'].includes(identifier?.split('.').at(-1) ?? '')
      ? 'awaiting_report'
      : reported;
  const status =
    outcome === 'done'
      ? '已完成'
      : outcome === 'error'
        ? 'Agent 报告失败'
        : outcome === 'unreported'
          ? '执行已结束，结果未知'
          : outcome === 'awaiting_report'
            ? '已请求，等待结果上报'
            : toolState === 'pending'
              ? '等待执行'
              : '执行中';
  return { label, outcome, status } as const;
}

interface AttemptRecord {
  id: string;
  number: number;
  state: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: { code?: string; message: string; retryable: boolean };
}

export function attemptNotices(attempts: AttemptRecord[], member: string) {
  return attempts.flatMap((attempt) => {
    const notices: {
      id: string;
      role: 'system';
      createdAt: number;
      text: string;
      status: 'complete';
    }[] = [];
    const start = attempt.startedAt ?? attempt.createdAt;
    if (attempt.number > 1 && start && Number.isFinite(Date.parse(start)))
      notices.push({
        id: `retry-${attempt.id}`,
        role: 'system',
        createdAt: Date.parse(start),
        text: `${member} · 第 ${attempt.number} 次执行：沿用此任务继续执行，前次记录仍保留。`,
        status: 'complete',
      });
    if (
      ['failed', 'interrupted'].includes(attempt.state) &&
      attempt.finishedAt &&
      Number.isFinite(Date.parse(attempt.finishedAt))
    )
      notices.push({
        id: `attempt-ended-${attempt.id}`,
        role: 'system',
        createdAt: Date.parse(attempt.finishedAt),
        text: `${member} · 第 ${attempt.number} 次执行${attempt.state === 'failed' ? '失败' : '中断'}：${failureSummary(attempt.failure?.message, attempt.failure?.code, false)}`,
        status: 'complete',
      });
    return notices;
  });
}
