export function failureSummary(
  message: string | undefined,
  code?: string,
  includeRetryAction = true,
) {
  const generic = '本次执行未完成，已有对话和结果仍保留。请查看执行过程，再决定重试或补充要求。';
  if (code === 'CONTROL_PLANE_RESTART')
    return '服务重启时，这次执行尚未结束。此前对话和改动仍保留，可回到会话继续任务。';
  if (code === 'AGENT_UPSTREAM_INTERNAL')
    return 'Agent 上游服务内部错误，本轮没有完成。已有对话和代码改动已保留，可直接重试。';
  if (code === 'ACP_TURN_INCOMPLETE')
    return 'Agent 回合提前结束，本轮没有完成。已有对话和代码改动已保留，可直接重试。';
  if (code === 'ACP_CONNECTION_CLOSED')
    return (
      'Agent 连接在任务完成前断开。已有对话和代码改动已保留。' +
      (includeRetryAction ? '点击“保留改动并重试”即可继续。' : '')
    );
  // The canonical fallback mentions authorization as one possible diagnostic.
  // It is not evidence of expired login; only specific diagnostics may say so.
  if (code === 'EXECUTION_FAILED') return generic;
  if (message && /auth|login|credentials|登录|认证/i.test(message))
    return '成员的登录状态需要处理。请先检查协作成员的登录状态。';
  if (message && /spawn|ENOENT|unavailable|not found|启动失败/i.test(message))
    return '成员程序或启动入口不可用。先检查协作成员的连接。';
  if (message && /timeout|timed out|超时/i.test(message))
    return '成员响应超时。已有对话和结果保留，请查看执行过程并核对成员状态。';
  return generic;
}
