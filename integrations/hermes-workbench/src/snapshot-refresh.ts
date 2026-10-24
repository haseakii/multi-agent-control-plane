/** One bounded read at a time; explicit refresh supersedes an older poll. */
export class SnapshotRefresh<T> {
  private flight?: { controller: AbortController; promise: Promise<void> };
  private disposed = false;

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<T>,
    private readonly apply: (value: T) => void,
    private readonly report: (error: unknown) => void,
    private readonly timeoutMs = 15_000,
    private readonly timeoutMessage = '更新任务状态超时。已有记录和输入仍保留，正在尝试重新连接。',
  ) {}

  refresh(fresh = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.flight && !fresh) return this.flight.promise;
    this.flight?.controller.abort();
    const controller = new AbortController();
    const promise = this.run(controller);
    this.flight = { controller, promise };
    return promise;
  }

  private async run(controller: AbortController) {
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(new Error(this.timeoutMessage)), this.timeoutMs);
      });
      const value = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return this.read(signal);
        }),
        interrupted,
      ]);
      if (!this.disposed && this.flight?.controller === controller) this.apply(value);
    } catch (error) {
      if (!this.disposed && this.flight?.controller === controller) this.report(error);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      controller.abort();
      if (this.flight?.controller === controller) this.flight = undefined;
    }
  }

  dispose() {
    this.disposed = true;
    this.flight?.controller.abort();
  }
}
