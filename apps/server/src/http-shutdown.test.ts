import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import { request, Agent } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { acquireInstanceLock as acquireNativeInstanceLock } from './release-config.js';
import { fixtureLockRemover } from '../fixtures/instance-lock-remover.js';
import { buildServer } from './server.js';
import { closeHttpServer, HttpDrainTimeoutError } from './http-shutdown.js';

mkdirSync(resolve('.data'), { recursive: true });
const acquireInstanceLock = (directory: string) =>
  acquireNativeInstanceLock(directory, undefined, fixtureLockRemover);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('HTTP shutdown did not finish within test deadline')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(
  configure?: (
    app: ReturnType<typeof buildServer>,
    storage: ReturnType<typeof openSqliteStorage>,
  ) => void,
) {
  const directory = mkdtempSync(resolve('.data/http-shutdown-test-'));
  const release = acquireInstanceLock(directory);
  const storage = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
  const app = buildServer();
  const sockets = new Set<Socket>();
  const order: string[] = [];
  const closed = deferred();
  let closeCount = 0;
  app.server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  app.server.once('close', () => order.push('http-closed'));
  app.addHook('onClose', async () => {
    storage.close();
    order.push('storage-closed');
    release();
    order.push('lock-released');
    closeCount++;
    closed.resolve();
  });
  configure?.(app, storage);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  const clients: Socket[] = [];
  async function raw() {
    const accepted = once(app.server, 'connection');
    const client = connect({ host: '127.0.0.1', port });
    clients.push(client);
    client.on('error', () => {});
    const connected = once(client, 'connect');
    const [serverSocket] = (await accepted) as [Socket];
    await connected;
    return { client, serverSocket };
  }
  function get(path: string, agent?: Agent) {
    return new Promise<{ status: number; body: string }>((yes, no) => {
      const req = request({ host: '127.0.0.1', port, path, agent }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.once('end', () => yes({ status: res.statusCode!, body }));
      });
      req.once('error', no);
      req.end();
    });
  }
  const locked = () => existsSync(join(directory, 'instance.lock'));
  async function cleanup() {
    for (const socket of clients) socket.destroy();
    for (const socket of sockets) socket.destroy();
    await app.close();
  }
  function assertClosed() {
    expect(locked()).toBe(false);
    expect(order).toEqual(['http-closed', 'storage-closed', 'lock-released']);
    expect(closeCount).toBe(1);
  }
  return { app, raw, get, storage, directory, order, closed, locked, cleanup, assertClosed };
}

// Tiny parser for the controlled Content-Length responses below, never real traffic.
function responses(socket: Socket) {
  let bytes = Buffer.alloc(0);
  const values: { status: number; body: string }[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  socket.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    for (;;) {
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) break;
      const headers = bytes.subarray(0, end).toString();
      const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length)) throw Error('Controlled response needs Content-Length');
      if (bytes.length < end + 4 + length) break;
      values.push({
        status: Number(headers.split(' ')[1]),
        body: bytes.subarray(end + 4, end + 4 + length).toString(),
      });
      bytes = bytes.subarray(end + 4 + length);
    }
    for (const entry of waiting) if (values.length >= entry.count) entry.resolve();
  });
  return {
    values,
    wait: async (count: number) => {
      if (values.length < count)
        await bounded(new Promise<void>((resolve) => waiting.push({ count, resolve })));
      return values;
    },
  };
}

describe('reused HTTP connections and response accounting', () => {
  it('closes a reused keepalive connection with partial next headers under repeated shutdown', async () => {
    const f = await fixture();
    try {
      const { client, serverSocket } = await f.raw(),
        reply = responses(client);
      client.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      expect((await reply.wait(1))[0]?.status).toBe(200);
      const received = once(serverSocket, 'data');
      client.write('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Test: partial second');
      await received;
      const closing = closeHttpServer(f.app, { drainTimeoutMs: 200 });
      expect(closeHttpServer(f.app)).toBe(closing);
      await bounded(closing);
      f.assertClosed();
    } finally {
      await f.cleanup();
    }
  });
  it('drains every pipelined request and complete response before closing the reused socket', async () => {
    const entered = [deferred(), deferred()],
      finish = [deferred(), deferred()];
    const f = await fixture((app, storage) => {
      for (const index of [0, 1])
        app.get('/pipeline-' + index, async () => {
          entered[index]!.resolve();
          await finish[index]!.promise;
          const now = new Date().toISOString();
          storage.repositories.projects.upsert({
            id: 'pipeline-' + index,
            name: 'persisted pipeline ' + index,
            createdAt: now,
            updatedAt: now,
          });
          return { index, payload: String(index).repeat(65536) };
        });
    });
    try {
      const { client, serverSocket } = await f.raw(),
        reply = responses(client);
      client.write(
        'GET /pipeline-0 HTTP/1.1\r\nHost: localhost\r\n\r\nGET /pipeline-1 HTTP/1.1\r\nHost: localhost\r\n\r\n',
      );
      await bounded(Promise.all(entered.map((x) => x.promise)));
      let done = false;
      const closing = closeHttpServer(f.app).then(() => {
        done = true;
      });
      finish[0]!.resolve();
      const first = (await reply.wait(1))[0]!;
      expect(JSON.parse(first.body)).toEqual({ index: 0, payload: '0'.repeat(65536) });
      expect(done).toBe(false);
      expect(serverSocket.destroyed).toBe(false);
      expect(f.locked()).toBe(true);
      finish[1]!.resolve();
      const second = (await reply.wait(2))[1]!;
      expect(JSON.parse(second.body)).toEqual({ index: 1, payload: '1'.repeat(65536) });
      await bounded(closing);
      f.assertClosed();
      const reopened = openSqliteStorage({ filename: join(f.directory, 'control-plane.sqlite') });
      try {
        expect(
          reopened.repositories.projects
            .list()
            .map((x) => x.id)
            .sort(),
        ).toEqual(['pipeline-0', 'pipeline-1']);
      } finally {
        reopened.close();
      }
    } finally {
      for (const gate of finish) gate.resolve();
      await f.cleanup();
    }
  });
  it('keeps the full final response when shutdown starts in its finish callback beside partial next headers', async () => {
    const started = deferred();
    let closing: Promise<void> | undefined;
    const payload = 'completed response '.repeat(8192);
    const f = await fixture((app, storage) => {
      app.get('/finish-race', async (_request, reply) => {
        const now = new Date().toISOString();
        storage.repositories.projects.upsert({
          id: 'finish-race',
          name: 'committed before finish',
          createdAt: now,
          updatedAt: now,
        });
        reply.raw.once('finish', () => {
          closing = closeHttpServer(app, { drainTimeoutMs: 200 });
          void closing.catch(() => {});
          started.resolve();
        });
        return { payload };
      });
    });
    try {
      const { client } = await f.raw(),
        reply = responses(client);
      client.write(
        'GET /finish-race HTTP/1.1\r\nHost: localhost\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nPartial:',
      );
      expect(JSON.parse((await reply.wait(1))[0]!.body)).toEqual({ payload });
      await bounded(started.promise);
      await bounded(closing!);
      f.assertClosed();
      const reopened = openSqliteStorage({ filename: join(f.directory, 'control-plane.sqlite') });
      try {
        expect(reopened.repositories.projects.get('finish-race')?.name).toBe(
          'committed before finish',
        );
      } finally {
        reopened.close();
      }
    } finally {
      await f.cleanup();
    }
  });
  it('settles an aborted response only once and permits later repeated shutdown', async () => {
    const entered = deferred(),
      finish = deferred(),
      handlerDone = deferred(),
      responseClosed = deferred();
    const f = await fixture((app) =>
      app.get('/abort', async (_request, reply) => {
        reply.raw.once('close', () => responseClosed.resolve());
        entered.resolve();
        await finish.promise;
        handlerDone.resolve();
        return { ignored: 'client already closed' };
      }),
    );
    try {
      const { client } = await f.raw();
      client.write('GET /abort HTTP/1.1\r\nHost: localhost\r\n\r\n');
      await bounded(entered.promise);
      client.destroy();
      await bounded(responseClosed.promise);
      finish.resolve();
      await bounded(handlerDone.promise);
      const closing = closeHttpServer(f.app);
      expect(closeHttpServer(f.app)).toBe(closing);
      await bounded(closing);
      f.assertClosed();
    } finally {
      finish.resolve();
      await f.cleanup();
    }
  });
});
describe('local HTTP shutdown lifecycle (no ACP or permission operations)', () => {
  it.each(['empty TCP', 'partial request headers'])(
    'closes %s before releasing durable ownership',
    async (mode) => {
      const f = await fixture();
      try {
        const { client, serverSocket } = await f.raw();
        if (mode === 'partial request headers') {
          const received = once(serverSocket, 'data');
          client.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Test: unfinished');
          await received;
        }
        await bounded(f.app.close());
        f.assertClosed();
      } finally {
        await f.cleanup();
      }
    },
  );
  it('closes ordinary keepalive without changing origin policy', async () => {
    const f = await fixture(),
      agent = new Agent({ keepAlive: true });
    try {
      expect((await f.get('/health', agent)).status).toBe(200);
      await bounded(f.app.close());
      f.assertClosed();
    } finally {
      agent.destroy();
      await f.cleanup();
    }
  });
  it('lets an in-flight request persist and reply before closing storage or releasing lock', async () => {
    const entered = deferred(),
      finish = deferred();
    const directory = mkdtempSync(resolve('.data/http-shutdown-drain-'));
    const release = acquireInstanceLock(directory),
      storage = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
    const app = buildServer();
    let storageClosed = false;
    app.get('/drain', async () => {
      entered.resolve();
      await finish.promise;
      const now = new Date().toISOString();
      storage.repositories.projects.upsert({
        id: 'drained-project',
        name: 'synthetic drain',
        createdAt: now,
        updatedAt: now,
      });
      return { saved: true };
    });
    app.addHook('onClose', async () => {
      storage.close();
      storageClosed = true;
      release();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = new Promise<{ status: number; body: unknown }>((yes, no) => {
      const req = request(address + '/drain', { agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.once('end', () => yes({ status: res.statusCode!, body: JSON.parse(body) }));
      });
      req.once('error', no);
      req.end();
    });
    try {
      await entered.promise;
      let done = false;
      const closing = app.close().then(() => {
        done = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      expect(storageClosed).toBe(false);
      expect(existsSync(join(directory, 'instance.lock'))).toBe(true);
      finish.resolve();
      expect(await response).toEqual({ status: 200, body: { saved: true } });
      await bounded(closing);
      expect(storageClosed).toBe(true);
      expect(existsSync(join(directory, 'instance.lock'))).toBe(false);
      const reopened = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
      try {
        expect(reopened.repositories.projects.get('drained-project')?.name).toBe('synthetic drain');
      } finally {
        reopened.close();
      }
    } finally {
      finish.resolve();
      await response.catch(() => {});
      await app.close();
    }
  });
  it('makes repeated shutdown idempotent', async () => {
    const f = await fixture();
    try {
      await f.raw();
      await bounded(Promise.all([f.app.close(), f.app.close()]));
      f.assertClosed();
    } finally {
      await f.cleanup();
    }
  });
  it('rejects a newly accepted raw connection while preClose is still draining', async () => {
    const entered = deferred(),
      finish = deferred();
    // Add the controlled preClose hook before listen without changing production handlers.
    const app = buildServer();
    app.addHook('preClose', async () => {
      entered.resolve();
      await finish.promise;
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    let client: Socket | undefined;
    try {
      const closing = app.close();
      await entered.promise;
      const accepted = once(app.server, 'connection');
      client = connect({ host: '127.0.0.1', port });
      client.on('error', () => {});
      const closed = new Promise<void>((resolve) => client!.once('close', () => resolve()));
      await accepted;
      await bounded(closed);
      finish.resolve();
      await bounded(closing);
    } finally {
      client?.destroy();
      finish.resolve();
      await app.close();
    }
  });

  it('keeps the first bounded shutdown result for duplicate callers', async () => {
    const f = await fixture();
    try {
      await f.raw();
      const first = closeHttpServer(f.app);
      expect(closeHttpServer(f.app)).toBe(first);
      await bounded(first);
      f.assertClosed();
    } finally {
      await f.cleanup();
    }
  });

  it('reports a drain deadline as failure while preserving in-flight persistence and lock', async () => {
    const directory = mkdtempSync(resolve('.data/http-shutdown-deadline-'));
    const release = acquireInstanceLock(directory);
    const storage = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
    const app = buildServer(),
      entered = deferred(),
      finish = deferred(),
      closed = deferred();
    app.get('/write', async () => {
      entered.resolve();
      await finish.promise;
      const now = new Date().toISOString();
      storage.repositories.projects.upsert({
        id: 'deadline-project',
        name: 'preserved after failed deadline',
        createdAt: now,
        updatedAt: now,
      });
      return { saved: true };
    });
    app.addHook('onClose', async () => {
      storage.close();
      release();
      closed.resolve();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = new Promise<string>((yes, no) => {
      const req = request(address + '/write', { agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.once('end', () => yes(body));
      });
      req.once('error', no);
      req.end();
    });
    try {
      await entered.promise;
      const stopping = closeHttpServer(app, { drainTimeoutMs: 20 });
      await expect(stopping).rejects.toBeInstanceOf(HttpDrainTimeoutError);
      expect(existsSync(join(directory, 'instance.lock'))).toBe(true);
      expect(storage.repositories.projects.list()).toEqual([]);
      expect(closeHttpServer(app)).toBe(stopping);
      finish.resolve();
      expect(JSON.parse(await response)).toEqual({ saved: true });
      await bounded(closed.promise);
      expect(existsSync(join(directory, 'instance.lock'))).toBe(false);
      await expect(stopping).rejects.toMatchObject({ code: 'HTTP_DRAIN_TIMEOUT' });
      const reopened = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
      try {
        expect(reopened.repositories.projects.get('deadline-project')?.name).toBe(
          'preserved after failed deadline',
        );
      } finally {
        reopened.close();
      }
    } finally {
      finish.resolve();
      await response.catch(() => {});
      await app.close();
    }
  });

  it('validates deadline options without weakening the shutdown state', async () => {
    const f = await fixture();
    try {
      expect(() => closeHttpServer(f.app, { drainTimeoutMs: 0 })).toThrow();
      expect(() => closeHttpServer(f.app, { drainTimeoutMs: NaN })).toThrow();
      await bounded(closeHttpServer(f.app));
      f.assertClosed();
    } finally {
      await f.cleanup();
    }
  });
});
