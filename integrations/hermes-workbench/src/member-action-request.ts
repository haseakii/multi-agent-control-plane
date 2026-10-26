export type MemberActionStage = 'activity' | 'members' | 'entry' | 'probe' | 'auth' | 'management';

const deadlines: Record<MemberActionStage, number> = {
  activity: 15_000,
  members: 15_000,
  entry: 15_000,
  probe: 30_000,
  // Allow the agent's five minute login window and time to return its result.
  auth: 330_000,
  management: 15_000,
};
const messages: Record<MemberActionStage, string> = {
  activity: '读取任务状态超时，尚未发起连接或登录。请刷新状态后重试。',
  members: '核对已有成员超时。接入草稿仍保留，请稍后重新核对。',
  entry: '本机入口检查尚未返回结果，尚未保存本次配置。请稍后重试。',
  probe: '连接检查结果尚未确认。后台可能仍在处理，请先刷新状态；这不代表登录失效。',
  auth: '登录结果尚未确认。请查看协作者自己的登录窗口，再刷新状态；不要重复发起登录。',
  management: '核对成员状态超时，尚未执行本次管理操作。请刷新成员状态后再试。',
};

/** Bound the browser's wait, not the agent operation. Never replay a POST after a lost reply. */
export async function memberActionRequest<T>(
  stage: MemberActionStage,
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = deadlines[stage],
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => request(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(messages[stage]);
          reject(error);
          controller.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
