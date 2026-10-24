import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const phases = new Set(['starting', 'ready', 'stopping']);
const stopped = Symbol('instance-stop-requested');

function processExists(pid) {
  try {
    process.kill(pid, 0); // Existence check only; never sends a termination signal.
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw new Error('Cannot establish whether the recorded instance exited; refusing takeover.');
  }
}

/** Shared entry lifecycle; callers supply the existing data-lock implementation.
 * Resource cleanup is registered immediately after construction, in acquisition order.
 */
export async function runWorkbenchInstance(
  { run, data, url, acquireLock, previousProcessExists = processExists },
  boot,
) {
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(url)?.[1]);
  if (!path.isAbsolute(run) || !path.isAbsolute(data) || !Number.isInteger(port) ||
      port < 1 || port > 65535)
    throw new Error('Invalid local instance paths or URL.');
  const release = acquireLock(data);
  const cleanup = [];
  const info = path.join(run, 'server.json');
  let metadata;
  let timer;
  let stopping = false;
  let finish;
  const stopRequested = new Promise((resolve) => { finish = resolve; });
  const requestStop = () => { stopping = true; finish(); };
  const publish = (value) => {
    const temporary = path.join(run, `server-${value.instanceId}-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, info);
  };
  const checkStop = () => {
    if (!metadata || stopping) return stopping;
    try {
      const value = fs.readFileSync(path.join(run, `stop-${metadata.instanceId}`), 'utf8');
      if (value.trim() === metadata.instanceId) requestStop();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Cannot read this instance stop request; stopping conservatively.');
        requestStop();
      }
    }
    return stopping;
  };
  const assertRunning = () => { if (checkStop()) throw stopped; };
  try {
    // New peers are excluded by the data lock. Older unlocked entry points are
    // not peers: refuse their still-live (or uncertain) process before opening SQLite.
    if (fs.existsSync(info)) {
      const known = JSON.parse(fs.readFileSync(info, 'utf8'));
      if (!Number.isSafeInteger(known.pid) || known.pid <= 0 ||
          typeof known.startedAt !== 'string' || !Number.isFinite(Date.parse(known.startedAt)) ||
          typeof known.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(known.url) ||
          (known.instanceId !== undefined && (!uuid.test(known.instanceId) || !phases.has(known.phase))))
        throw new Error('Invalid prior instance metadata; retained without takeover.');
      if (previousProcessExists(known.pid))
        throw new Error('Recorded instance may still be running. Confirm its exit before starting this version.');
    }
    if (fs.existsSync(path.join(run, 'stop')))
      console.warn('Legacy unscoped stop marker retained; this generation only accepts its own stop token.');
    metadata = {
      url, pid: process.pid, instanceId: randomUUID(),
      startedAt: new Date().toISOString(), phase: 'starting',
    };
    publish(metadata); // Starting identity exists before any database open or await in boot.
    process.on('SIGINT', requestStop);
    process.on('SIGTERM', requestStop);
    timer = setInterval(checkStop, 300);
    await boot({
      assertRunning,
      get stopping() { return checkStop(); },
      defer(close) {
        if (typeof close !== 'function') throw new Error('Invalid resource cleanup.');
        cleanup.push(close);
      },
      acquireResource(open, close) {
        let resource;
        let acquired = false;
        let failure;
        cleanup.push(async () => {
          if (!acquired)
            throw new Error('Resource initialization incomplete; data lock retained.', { cause: failure });
          await close(resource);
        });
        try {
          resource = open();
          acquired = true;
          return resource;
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      ready(extra = {}) {
        assertRunning();
        metadata = { ...extra, ...metadata, phase: 'ready' };
        publish(metadata);
        // A request arriving during rename remains in its generation-specific file.
        assertRunning();
      },
    });
    await stopRequested;
  } catch (error) {
    if (error !== stopped) throw error;
  } finally {
    clearInterval(timer);
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    if (metadata) {
      try { publish({ ...metadata, phase: 'stopping' }); }
      catch (error) { console.error('Stopping metadata was not saved:', error.message); }
    }
    try {
      // HTTP drain precedes runtime/storage cleanup. A failed drain/cleanup must
      // retain ownership, never close SQLite beneath a still-running handler.
      for (const close of cleanup.reverse()) await close();
    } catch (error) {
      console.error('Instance cleanup incomplete; data lock retained.');
      throw error;
    }
    release();
  }
}
