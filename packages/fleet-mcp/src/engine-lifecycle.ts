import { setTimeout as delay } from 'node:timers/promises';

export function createEngineLifecycle(options: {
  health: () => Promise<void>;
  launch?: () => Promise<void>;
  wait?: () => Promise<unknown>;
  attempts?: number;
}) {
  let pending: Promise<void> | undefined;
  async function ensure() {
    try {
      await options.health();
      return;
    } catch (error) {
      if (
        (error as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED' ||
        !options.launch
      )
        throw error;
    }
    await options.launch();
    for (let i = 0; i < (options.attempts ?? 100); i++) {
      try {
        await options.health();
        return;
      } catch (error) {
        if ((error as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED') throw error;
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
