import { setTimeout as delay } from 'node:timers/promises';

export function createEngineLifecycle(options: {
  health: () => Promise<void>;
  launch?: () => Promise<void>;
  wait?: () => Promise<unknown>;
  attempts?: number;
}) {
  // fetch nests the socket error in cause; our direct loopback transport returns it directly.
  const refused = (error: unknown) => {
    const value = error as { code?: string; cause?: { code?: string } };
    return value?.code === 'ECONNREFUSED' || value?.cause?.code === 'ECONNREFUSED';
  };
  let pending: Promise<void> | undefined;
  async function ensure() {
    try {
      await options.health();
      return;
    } catch (error) {
      if (!refused(error) || !options.launch) throw error;
    }
    await options.launch();
    for (let i = 0; i < (options.attempts ?? 100); i++) {
      try {
        await options.health();
        return;
      } catch (error) {
        if (!refused(error)) throw error;
        await (options.wait?.() ?? delay(250));
      }
    }
    throw new Error('Engine startup timed out. Inspect the local startup log.');
  }
  return {
    ensure: () =>
      (pending ??= ensure().finally(() => {
        pending = undefined;
      })),
  };
}
