import { expect, it, vi } from 'vitest';
import { createEngineLifecycle } from './engine-lifecycle.js';
import { windowsArgument } from './background-launch.js';
import { createServer } from 'node:http';
import { loopbackFetch } from './loopback-fetch.js';
const refused = () => Object.assign(new Error('offline'), { cause: { code: 'ECONNREFUSED' } });
it('recognizes direct socket refusals during both initial detection and startup waiting', async () => {
  let probes = 0;
  const launch = vi.fn(async () => {}),
    wait = vi.fn(async () => {});
  const engine = createEngineLifecycle({
    health: async () => {
      if (++probes < 3) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    },
    launch,
    wait,
  });
  await engine.ensure();
  expect(launch).toHaveBeenCalledTimes(1);
  expect(wait).toHaveBeenCalledTimes(1);
});
it('cold-starts against the real direct loopback HTTP transport', async () => {
  const server = createServer((_request, response) => response.end('{"status":"ok"}'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No test port');
  const port = address.port;
  await new Promise<void>((ok) => server.close(() => ok()));
  const launch = vi.fn(async () => {
    await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  });
  const engine = createEngineLifecycle({
    health: async () => {
      const r = await loopbackFetch('http://127.0.0.1:' + port);
      await r.json();
    },
    launch,
  });
  try {
    await engine.ensure();
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
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
