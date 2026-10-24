import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runWorkbenchInstance } from '../instance-lifecycle.mjs';

const roots = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve(tmpdir()) + path.sep)) throw Error('Unsafe fixture cleanup.');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const run = fs.mkdtempSync(path.join(tmpdir(), 'hermes-lifecycle-'));
  roots.push(run);
  let locked = false;
  const release = vi.fn(() => {
    locked = false;
  });
  const acquireLock = vi.fn(() => {
    if (locked) throw Error('Data directory is locked');
    locked = true;
    return release;
  });
  const options = {
    run,
    data: path.join(run, 'data'),
    url: 'http://127.0.0.1:8047',
    acquireLock,
    previousProcessExists: () => false,
  };
  const info = () => JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
  const stop = (id = info().instanceId) => fs.writeFileSync(path.join(run, `stop-${id}`), id);
  return { options, info, stop, release, locked: () => locked };
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it('excludes a second boot before storage setup and retains ownership through complete HTTP drain', async () => {
  const f = fixture(),
    entered = deferred(),
    drain = deferred(),
    order = [];
  const running = runWorkbenchInstance(f.options, async (host) => {
    expect(f.locked()).toBe(true);
    host.defer(() => {
      order.push('storage');
    });
    host.defer(() => {
      order.push('runtime');
    });
    host.defer(async () => {
      order.push('http');
      await drain.promise;
    });
    host.ready();
    entered.resolve();
  });
  await entered.promise;
  const secondBoot = vi.fn();
  await expect(runWorkbenchInstance(f.options, secondBoot)).rejects.toThrow('locked');
  expect(secondBoot).not.toHaveBeenCalled();
  f.stop();
  await vi.advanceTimersByTimeAsync(300);
  expect(order).toEqual(['http']);
  expect(f.locked()).toBe(true);
  drain.resolve();
  await running;
  expect(order).toEqual(['http', 'runtime', 'storage']);
  expect(f.release).toHaveBeenCalledTimes(1);
});

it('retains ownership and storage if HTTP cleanup cannot be confirmed', async () => {
  const f = fixture(),
    storageClose = vi.fn();
  const running = runWorkbenchInstance(f.options, async (host) => {
    host.defer(storageClose);
    host.defer(async () => {
      throw Error('HTTP drain incomplete');
    });
    f.stop();
    host.ready();
  });
  await expect(running).rejects.toThrow('HTTP drain incomplete');
  expect(storageClose).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

it('retains ownership if a resource constructor fails before returning its close handle', async () => {
  const f = fixture(),
    close = vi.fn();
  const running = runWorkbenchInstance(f.options, async (host) => {
    host.acquireResource(() => {
      throw Error('migration failed');
    }, close);
  });
  await expect(running).rejects.toThrow('Resource initialization incomplete');
  expect(close).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

it('honors a stop submitted to the starting generation without publishing ready', async () => {
  const f = fixture();
  let afterReady = false;
  await runWorkbenchInstance(f.options, async (host) => {
    expect(f.info().phase).toBe('starting');
    f.stop();
    host.ready();
    afterReady = true;
  });
  expect(afterReady).toBe(false);
  expect(f.info().phase).toBe('stopping');
  expect(fs.existsSync(path.join(f.options.run, `stop-${f.info().instanceId}`))).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(1);
});

it('retains a stop arriving during ready publication instead of deleting it', async () => {
  const f = fixture(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (f.info().phase === 'ready') f.stop();
  });
  await runWorkbenchInstance(f.options, async (host) => host.ready());
  expect(f.info().phase).toBe('stopping');
  expect(fs.existsSync(path.join(f.options.run, `stop-${f.info().instanceId}`))).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(1);
});

it('ignores retained legacy and prior-generation stop markers without deleting them', async () => {
  const f = fixture(),
    entered = deferred();
  const previous = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(f.options.run, 'stop'), 'stop');
  f.stop(previous);
  const running = runWorkbenchInstance(f.options, async (host) => {
    host.ready();
    entered.resolve();
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(300);
  expect(f.info().phase).toBe('ready');
  expect(f.locked()).toBe(true);
  f.stop();
  await vi.advanceTimersByTimeAsync(300);
  await running;
  expect(fs.readFileSync(path.join(f.options.run, 'stop'), 'utf8')).toBe('stop');
  expect(fs.existsSync(path.join(f.options.run, `stop-${previous}`))).toBe(true);
});

it('refuses a still-live legacy record before entering database setup', async () => {
  const f = fixture(),
    boot = vi.fn();
  fs.writeFileSync(
    path.join(f.options.run, 'server.json'),
    JSON.stringify({
      pid: 12345,
      url: f.options.url,
      startedAt: new Date().toISOString(),
    }),
  );
  await expect(
    runWorkbenchInstance({ ...f.options, previousProcessExists: () => true }, boot),
  ).rejects.toThrow('may still be running');
  expect(boot).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
});
