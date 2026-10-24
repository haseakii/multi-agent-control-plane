export interface ConnectionBatchProgress<T> {
  completed: number;
  total: number;
  current?: T;
}

/** Stop between entries only: an in-flight registration/probe must settle first. */
export async function runConnectionBatch<T>(
  items: readonly T[],
  connect: (item: T) => Promise<void>,
  shouldPause: () => boolean,
  onProgress: (progress: ConnectionBatchProgress<T>) => void,
) {
  let completed = 0;
  for (const item of items) {
    if (shouldPause()) break;
    onProgress({ completed, total: items.length, current: item });
    await connect(item);
    completed++;
    onProgress({ completed, total: items.length });
  }
  return { completed, total: items.length, paused: completed < items.length };
}
