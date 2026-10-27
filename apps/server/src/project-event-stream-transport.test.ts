import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ProjectEventNoticeSchema,
  type ProjectEventReader,
  type ProjectEventPage,
} from '@control-plane/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerProjectEventStream } from './project-event-stream.js';

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  chunks: string[] = [];
  writeHead = vi.fn();
  write = vi.fn((text: string) => {
    this.chunks.push(text);
    return true;
  });
  end = vi.fn(() => {
    this.writableEnded = true;
    this.emit('close');
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('close');
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const close: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
  vi.useRealTimers();
});
function fixture() {
  let route!: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  let stop!: () => Promise<void>;
  const reader = {
    latest: vi.fn<ProjectEventReader['latest']>(() => 'head'),
    readAfter: vi.fn<ProjectEventReader['readAfter']>(() => ({ status: 'events', events: [] })),
  };
  const app = {
    get: (_path: string, handler: typeof route) => {
      route = handler;
    },
    addHook: (_name: string, handler: typeof stop) => {
      stop = handler;
    },
  } as unknown as FastifyInstance;
  registerProjectEventStream(app, reader);
  close.push(() => stop());
  function connect(projectId = 'p', cursor?: string, raw = new Response()) {
    const reply = {
      raw,
      status: 200,
      body: undefined as unknown,
      hijack: vi.fn(),
      code: vi.fn((status: number) => {
        reply.status = status;
        return reply;
      }),
      send: vi.fn((body: unknown) => {
        reply.body = body;
        return reply;
      }),
    };
    const request = {
      params: { id: projectId },
      query: {},
      headers: cursor === undefined ? {} : { 'last-event-id': cursor },
    };
    const done = route(request as unknown as FastifyRequest, reply as unknown as FastifyReply);
    return { reply, raw, done };
  }
  return { reader, connect, stop: () => stop() };
}
const notice = (id: string, projectId = 'p') =>
  ProjectEventNoticeSchema.parse({
    id,
    projectId,
    type: 'test.notice',
    occurredAt: '2026-10-27T00:00:00Z',
  });
const flush = () => vi.advanceTimersByTimeAsync(0);
const events = (response: Response) =>
  response.chunks.filter((text) => text.includes('event: control-event\n'));

it('replays several bounded pages without advancing the reconnect ID ahead of delivery', async () => {
  const f = fixture();
  const rows = Array.from({ length: 251 }, (_, i) => notice('event-' + i));
  f.reader.readAfter.mockImplementation((_project, query) => ({
    status: 'events',
    events: rows.slice(rows.findIndex((row) => row.id === query.after) + 1).slice(0, query.limit),
  }));
  const client = f.connect('p', 'event-0');
  await client.done;
  await flush();
  expect(events(client.raw)).toHaveLength(100);
  const ready = client.raw.chunks.find((text) => text.includes('event: ready'))!;
  expect(ready).not.toContain('id:');
  await vi.advanceTimersByTimeAsync(500);
  expect(events(client.raw)).toHaveLength(200);
  await vi.advanceTimersByTimeAsync(500);
  expect(events(client.raw)).toHaveLength(250);
  expect(f.reader.readAfter.mock.calls.map(([, query]) => query)).toEqual([
    { after: 'event-0', limit: 100 },
    { after: 'event-100', limit: 100 },
    { after: 'event-200', limit: 100 },
  ]);
  expect(new Set(events(client.raw).map((text) => text.split('\n')[0])).size).toBe(250);
});

it('allows only one pending read per subscriber while other projects continue, and ignores late shutdown results', async () => {
  const f = fixture(),
    gate = deferred<ProjectEventPage>();
  f.reader.readAfter.mockImplementation((project) =>
    project === 'p' ? gate.promise : { status: 'events', events: [notice('other-event', 'other')] },
  );
  const blocked = f.connect(),
    other = f.connect('other');
  await Promise.all([blocked.done, other.done]);
  await flush();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.reader.readAfter.mock.calls.filter(([project]) => project === 'p')).toHaveLength(1);
  expect(events(other.raw).length).toBeGreaterThan(0);
  await f.stop();
  const writes = blocked.raw.write.mock.calls.length;
  gate.resolve({ status: 'events', events: [notice('late')] });
  await flush();
  expect(blocked.raw.write).toHaveBeenCalledTimes(writes);
  expect(blocked.raw.end).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['throw', 'reject'])(
  'isolates a reader failure (%s) without stopping another client',
  async (mode) => {
    const f = fixture();
    f.reader.readAfter.mockImplementation((project) => {
      if (project === 'p') {
        if (mode === 'throw') throw Error('private database failure');
        return Promise.reject(Error('private database failure'));
      }
      return { status: 'events', events: [notice('other-event', 'other')] };
    });
    const failed = f.connect(),
      healthy = f.connect('other');
    await Promise.all([failed.done, healthy.done]);
    await flush();
    expect(failed.raw.chunks.join('')).toContain('event: unavailable');
    expect(failed.raw.chunks.join('')).not.toContain('private database failure');
    expect(failed.raw.end).toHaveBeenCalledOnce();
    expect(events(healthy.raw)).toHaveLength(1);
  },
);

it.each(['backpressure', 'throw', 'error'])(
  'releases a failed transport (%s) and stops polling it',
  async (mode) => {
    const f = fixture(),
      raw = new Response();
    if (mode === 'backpressure') raw.write.mockReturnValueOnce(false);
    if (mode === 'throw')
      raw.write.mockImplementationOnce(() => {
        throw Error('write failed');
      });
    const client = f.connect('p', undefined, raw);
    await client.done;
    await flush();
    if (mode === 'error') raw.emit('error', Error('socket failed'));
    const reads = f.reader.readAfter.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(raw.end).not.toHaveBeenCalled();
    expect(f.reader.readAfter).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
    const healthy = f.connect('other');
    await healthy.done;
    await flush();
    expect(healthy.reply.status).toBe(200);
  },
);

it('does not leak another project or full audit payloads from an invalid reader implementation', async () => {
  const f = fixture();
  f.reader.readAfter.mockReturnValue({ status: 'events', events: [notice('foreign', 'other')] });
  const client = f.connect();
  await client.done;
  await flush();
  expect(events(client.raw)).toHaveLength(0);
  expect(client.raw.chunks.join('')).toContain('event: unavailable');
  expect(client.raw.chunks.join('')).not.toContain('foreign');
});

it('reserves capacity before asynchronous opening and rejects late opens during shutdown', async () => {
  const f = fixture(),
    gate = deferred<string | undefined>();
  f.reader.latest.mockReturnValue(gate.promise);
  const clients = Array.from({ length: 16 }, () => f.connect());
  const extra = f.connect();
  await extra.done;
  expect(extra.reply.status).toBe(429);
  expect(f.reader.latest).toHaveBeenCalledTimes(16);
  await f.stop();
  gate.resolve('head');
  await Promise.all(clients.map((client) => client.done));
  for (const client of clients) {
    expect(client.reply.status).toBe(503);
    expect(client.reply.hijack).not.toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('shares a page read for matching project cursors and releases disconnected subscribers', async () => {
  const f = fixture(),
    a = f.connect(),
    b = f.connect();
  await Promise.all([a.done, b.done]);
  await flush();
  f.reader.readAfter.mockClear();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.reader.readAfter).toHaveBeenCalledOnce();
  a.raw.emit('close');
  b.raw.emit('close');
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.reader.readAfter).toHaveBeenCalledOnce();
});

it.each(['head', undefined])(
  'resets an unavailable cursor (%s) before resuming',
  async (cursor) => {
    const f = fixture();
    f.reader.readAfter.mockReturnValueOnce({
      status: 'reset',
      ...(cursor === undefined ? {} : { cursor: notice(cursor).id }),
    });
    const client = f.connect('p', 'unknown');
    await client.done;
    await flush();
    expect(client.raw.chunks.join('')).toContain('id: ' + (cursor ?? '') + '\nevent: reset');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.reader.readAfter).toHaveBeenLastCalledWith('p', {
      ...(cursor === undefined ? {} : { after: cursor }),
      limit: 100,
    });
  },
);

it('validates cursors and reports missing projects before hijacking the response', async () => {
  const f = fixture();
  const invalid = f.connect('p', '%invalid');
  await invalid.done;
  expect(invalid.reply.status).toBe(400);
  expect(f.reader.latest).not.toHaveBeenCalled();
  f.reader.latest.mockRejectedValueOnce({ statusCode: 404 });
  const missing = f.connect('missing');
  await missing.done;
  expect(missing.reply.status).toBe(404);
  expect(missing.reply.hijack).not.toHaveBeenCalled();
});

it('pauses at an accepted buffered frame and resumes from that frame after drain', async () => {
  const f = fixture(),
    raw = new Response();
  let buffered = false;
  raw.write.mockImplementation((text) => {
    raw.chunks.push(text);
    if (!buffered && text.includes('event: control-event')) {
      buffered = true;
      return false;
    }
    return true;
  });
  f.reader.readAfter.mockImplementation((_project, query) => ({
    status: 'events',
    events:
      query.after === 'head'
        ? [notice('first'), notice('second')]
        : query.after === 'first'
          ? [notice('second')]
          : [],
  }));
  const client = f.connect('p', undefined, raw);
  await client.done;
  await flush();
  expect(events(raw)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.reader.readAfter).toHaveBeenCalledOnce();
  expect(raw.destroy).not.toHaveBeenCalled();
  raw.emit('drain');
  await vi.advanceTimersByTimeAsync(500);
  expect(f.reader.readAfter).toHaveBeenLastCalledWith('p', { after: 'first', limit: 100 });
  expect(events(raw)).toHaveLength(2);
  expect(events(raw)[1]).toContain('id: second\n');
  await vi.advanceTimersByTimeAsync(5000);
  expect(raw.destroy).not.toHaveBeenCalled();
  expect(raw.listenerCount('drain')).toBe(0);
});

it('does not wait for a blocked peer during shutdown and clears its drain deadline', async () => {
  const f = fixture(),
    raw = new Response();
  raw.write.mockReturnValue(false);
  const client = f.connect('p', undefined, raw);
  await client.done;
  await flush();
  expect(raw.destroy).not.toHaveBeenCalled();
  expect(raw.listenerCount('drain')).toBe(1);
  await f.stop();
  expect(raw.destroy).toHaveBeenCalledOnce();
  expect(raw.end).not.toHaveBeenCalled();
  expect(raw.listenerCount('drain')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('disposes a connection when even its read-failure notice cannot drain', async () => {
  const f = fixture(),
    raw = new Response();
  f.reader.readAfter.mockRejectedValue(Error('read failed'));
  raw.write.mockImplementation((text) => {
    raw.chunks.push(text);
    return !text.includes('event: unavailable');
  });
  const client = f.connect('p', undefined, raw);
  await client.done;
  await flush();
  expect(raw.destroy).toHaveBeenCalledOnce();
  expect(raw.end).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
