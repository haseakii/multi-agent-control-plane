import { expect, it, vi } from 'vitest';
import { createEngineLifecycle } from './engine-lifecycle.js';
import { windowsArgument } from './background-launch.js';
const refused = () => Object.assign(new Error('offline'), { cause: { code: 'ECONNREFUSED' } });
it('coalesces parallel cold starts and restarts after a later outage', async () => {
  let live = false;
  const launch = vi.fn(async () => {
    live = true;
  });
  const engine = createEngineLifecycle({
    health: async () => {
      if (!live) throw refused();
    },
    launch,
  });
  await Promise.all([engine.ensure(), engine.ensure(), engine.ensure()]);
  expect(launch).toHaveBeenCalledTimes(1);
  await engine.ensure();
  expect(launch).toHaveBeenCalledTimes(1);
  live = false;
  await engine.ensure();
  expect(launch).toHaveBeenCalledTimes(2);
});
it('does not launch for a different or unresponsive service', async () => {
  const launch = vi.fn(async () => {});
  const engine = createEngineLifecycle({
    health: async () => {
      throw new Error('foreign');
    },
    launch,
  });
  await expect(engine.ensure()).rejects.toThrow('foreign');
  expect(launch).not.toHaveBeenCalled();
});
it('bounds unavailable startup and permits a subsequent retry', async () => {
  const engine = createEngineLifecycle({
    health: async () => {
      throw refused();
    },
    launch: async () => {},
    wait: async () => {},
    attempts: 2,
  });
  await expect(engine.ensure()).rejects.toThrow('timed out');
  await expect(engine.ensure()).rejects.toThrow('timed out');
});
it('quotes Windows paths, embedded quotes and trailing slashes without a shell', () => {
  expect(windowsArgument('a b')).toBe('"a b"');
  expect(windowsArgument('a"b')).toBe('"a\\"b"');
  expect(windowsArgument('C:\\space x\\')).toBe('"C:\\space x\\\\"');
  expect(windowsArgument('$(anything); & test')).toBe('"$(anything); & test"');
});
