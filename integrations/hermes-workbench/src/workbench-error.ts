/** Keep server-provided explanations, removing the transport JSON wrapper for users. */
export function workbenchError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed/i.test(message))
    return '暂时无法连接协作引擎。请确认操作台服务正在运行，再点击重新连接；输入内容会保留。';
  const http = message.match(/^HTTP (\d+):\s*([\s\S]*)$/);
  if (http) {
    try {
      const body: unknown = JSON.parse(http[2]!);
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
        message = body.error;
      else return `请求未完成（HTTP ${http[1]}），请刷新状态后查看任务记录。`;
    } catch {
      return `请求未完成（HTTP ${http[1]}），请刷新状态后查看任务记录。`;
    }
  }
  const known: Record<string, string> = {
    'Task is already executing.': '任务已经在执行，请刷新查看进度，无需再次启动。',
    'Task already has an execution or is not ready.': '任务状态已经变化，请刷新后查看当前执行。',
    'Task has no assignment to resume.': '这份任务还没有可恢复的执行，请先确认负责人并启动。',
    'Agent is missing or disabled.': '原执行成员不可用或已停用，请在协作成员中检查。',
    'Control plane is stopping.': '协作引擎正在停止。请等待退出并重新打开操作台，再发送要求。',
    'Execution gateway is not ready.': '协作引擎尚未就绪，请稍后重新连接。',
    'V0 concurrent execution limit reached.': '当前同时执行的任务已满，请等已有任务结束后再发送。',
    'Approval is already decided or expired.': '这项操作确认已经处理或过期，请刷新查看最新状态。',
    'Task not found.': '这份任务暂时无法读取，请刷新历史记录后重试。',
  };
  return Object.hasOwn(known, message) ? known[message]! : message;
}
