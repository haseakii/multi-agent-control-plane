/** Limit the browser wait only. A lost reply never cancels or replays the Agent task. */
async function boundedRequest<T>(
  send: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => send(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
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

export const resumeRequest = <T>(send: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000) =>
  boundedRequest(
    send,
    timeoutMs,
    '尚未收到重试请求的确认，后台可能已经开始执行。已有对话和改动仍保留，请先查看最新任务状态；不要重复点击重试。',
  );

/** Directory preflight is read-only. Do not let it indefinitely lock the composer either. */
export const workspaceReadRequest = <T>(send: (signal: AbortSignal) => Promise<T>) =>
  boundedRequest(
    send,
    15_000,
    '读取工作目录状态超时，尚未发送本次操作。输入和已有改动仍保留，请重新连接后再试。',
  );
