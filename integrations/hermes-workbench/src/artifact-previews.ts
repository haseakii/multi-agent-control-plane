export interface PreviewSource {
  id: string;
  sha256: string;
}

type Entry = {
  source: PreviewSource;
  controller: AbortController;
  state: 'loading' | 'ready' | 'error';
  timer?: ReturnType<typeof setTimeout>;
  content?: string;
  error?: string;
};

export interface PreviewSnapshot {
  content: Record<string, string>;
  errors: Record<string, string>;
}

/** Owns preview I/O independently of snapshot polling. Each entry is its request token. */
export class ArtifactPreviewLoader {
  private scope: string | null = null;
  private entries = new Map<string, Entry>();
  private disposed = false;

  constructor(
    private readonly read: (id: string, signal: AbortSignal) => Promise<string>,
    private readonly changed: (snapshot: PreviewSnapshot) => void,
    private readonly timeoutMs = 15_000,
  ) {}

  synchronize(scope: string | null, sources: readonly PreviewSource[]): void {
    this.disposed = false;
    if (scope !== this.scope) {
      this.cancelAll();
      this.scope = scope;
    }
    const wanted = new Map((scope === null ? [] : sources).map((source) => [source.id, source]));
    for (const [id, entry] of this.entries) {
      if (wanted.get(id)?.sha256 !== entry.source.sha256) {
        this.cancel(entry);
        this.entries.delete(id);
      }
    }
    for (const source of wanted.values()) if (!this.entries.has(source.id)) this.start(source);
    this.publish();
  }

  retry(id: string): void {
    const current = this.entries.get(id);
    if (this.disposed || !current || current.state !== 'error') return;
    this.cancel(current);
    this.entries.delete(id);
    this.start(current.source);
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.scope = null;
  }

  private cancel(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.controller.abort();
  }

  private cancelAll(): void {
    for (const entry of this.entries.values()) this.cancel(entry);
    this.entries.clear();
  }

  private current(entry: Entry): boolean {
    return (
      !this.disposed && this.entries.get(entry.source.id) === entry && entry.state === 'loading'
    );
  }

  private start(source: PreviewSource): void {
    const entry: Entry = {
      source: { ...source },
      controller: new AbortController(),
      state: 'loading',
    };
    this.entries.set(source.id, entry);
    entry.timer = setTimeout(() => {
      if (!this.current(entry)) return;
      entry.state = 'error';
      entry.error = '结果预览读取超时，请重新读取。';
      entry.controller.abort();
      this.publish();
    }, this.timeoutMs);
    void Promise.resolve()
      .then(() => {
        if (!this.current(entry)) return undefined;
        return this.read(source.id, entry.controller.signal);
      })
      .then(
        (content) => {
          if (!this.current(entry) || content === undefined) return;
          clearTimeout(entry.timer);
          entry.state = 'ready';
          entry.content = content;
          this.publish();
        },
        (cause: unknown) => {
          if (!this.current(entry)) return;
          clearTimeout(entry.timer);
          entry.state = 'error';
          entry.error = cause instanceof Error ? cause.message : '结果预览读取失败。';
          this.publish();
        },
      );
  }

  private publish(): void {
    if (this.disposed) return;
    const content: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const [id, entry] of this.entries) {
      if (entry.state === 'ready') content[id] = entry.content!;
      if (entry.state === 'error') errors[id] = entry.error!;
    }
    this.changed({ content, errors });
  }
}
