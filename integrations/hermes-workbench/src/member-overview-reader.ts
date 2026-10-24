import { SnapshotRefresh } from './snapshot-refresh';

type ReadChannel<T> = {
  read: (signal: AbortSignal) => Promise<T>;
  loading: () => void;
  apply: (value: T) => void;
  failed: (error: unknown) => void;
};

/** A slow history read must not hide successfully loaded member configuration. */
export class MemberOverviewReader<Members, History> {
  private readonly members: SnapshotRefresh<Members>;
  private readonly history: SnapshotRefresh<History>;
  private disposed = false;

  constructor(
    private readonly memberChannel: ReadChannel<Members>,
    private readonly historyChannel: ReadChannel<History>,
    timeoutMs = 15_000,
  ) {
    this.members = new SnapshotRefresh(
      memberChannel.read,
      memberChannel.apply,
      memberChannel.failed,
      timeoutMs,
      '读取成员状态超时，请点击刷新状态重试。已有配置和草稿仍保留。',
    );
    this.history = new SnapshotRefresh(
      historyChannel.read,
      historyChannel.apply,
      historyChannel.failed,
      timeoutMs,
      '读取最近执行超时，请点击刷新状态重试。',
    );
  }

  async refresh() {
    if (this.disposed) return;
    this.memberChannel.loading();
    this.historyChannel.loading();
    await Promise.all([this.members.refresh(true), this.history.refresh(true)]);
  }

  dispose() {
    this.disposed = true;
    this.members.dispose();
    this.history.dispose();
  }
}
