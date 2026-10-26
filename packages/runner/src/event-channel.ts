export class EventChannel<T> {
  private readonly history: T[] = [];
  private readonly subscribers = new Set<{
    queue: T[];
    wake: (() => void) | undefined;
  }>();
  private closed = false;
  private historyBytes = 0;

  constructor(
    private readonly historyLimit: number,
    private readonly byteSize: (value: T) => number = () => 0,
  ) {}

  get retainedBytes(): number {
    return this.historyBytes;
  }

  clearHistory(): void {
    this.history.length = 0;
    this.historyBytes = 0;
  }

  publish(value: T): void {
    if (this.closed) {
      return;
    }

    this.history.push(value);
    this.historyBytes += this.byteSize(value);
    if (this.history.length > this.historyLimit) {
      for (const removed of this.history.splice(0, this.history.length - this.historyLimit))
        this.historyBytes -= this.byteSize(removed);
    }

    for (const subscriber of this.subscribers) {
      subscriber.queue.push(value);
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const subscriber of this.subscribers) {
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  }

  async *subscribe(replay: boolean): AsyncGenerator<T, void, void> {
    const subscriber = {
      queue: replay ? [...this.history] : [],
      wake: undefined as (() => void) | undefined,
    };
    this.subscribers.add(subscriber);

    try {
      for (;;) {
        const value = subscriber.queue.shift();
        if (value !== undefined) {
          yield value;
          continue;
        }
        if (this.closed) {
          return;
        }

        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
        });
      }
    } finally {
      this.subscribers.delete(subscriber);
    }
  }
}
