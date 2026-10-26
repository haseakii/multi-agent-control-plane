import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  PROJECT_EVENT_PAGE_LIMIT,
  ProjectEventNoticeSchema,
  ProjectEventPageSchema,
  type ProjectEventReader,
  type ProjectEventPage,
} from '@control-plane/core';
import { z } from 'zod';

const Query = z.object({ after: z.string().max(1024).optional() }).strict();
type Subscriber = {
  projectId: string;
  cursor: string | undefined;
  reply: FastifyReply;
  heartbeatAt: number;
  reading: boolean;
  backpressure?: { timer: ReturnType<typeof setTimeout>; drain: () => void };
};

/** Bounded durable notifications; reconnects replay from the last received event ID. */
export function registerProjectEventStream(app: FastifyInstance, reader: ProjectEventReader) {
  const subscribers = new Set<Subscriber>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false,
    opening = 0;

  function remove(client: Subscriber) {
    const removed = subscribers.delete(client);
    if (client.backpressure) {
      clearTimeout(client.backpressure.timer);
      client.reply.raw.off('drain', client.backpressure.drain);
      delete client.backpressure;
    }
    if (!subscribers.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    return removed;
  }
  function finish(client: Subscriber, abrupt = !!client.backpressure) {
    if (!remove(client)) return;
    try {
      if (abrupt) client.reply.raw.destroy();
      else client.reply.raw.end();
    } catch {
      // A broken transport must not escape the polling loop or block other clients.
      try {
        client.reply.raw.destroy();
      } catch {
        /* Already closed. */
      }
    }
  }
  function write(client: Subscriber, text: string) {
    if (!subscribers.has(client) || client.backpressure) return false;
    try {
      const raw = client.reply.raw;
      if (!raw.destroyed && !raw.writableEnded) {
        if (!raw.write(text)) {
          // false means accepted but buffered. Pause before reading another page;
          // destroying immediately can discard the entire batch before a healthy peer receives it.
          const drain = () => {
            if (!client.backpressure) return;
            clearTimeout(client.backpressure.timer);
            delete client.backpressure;
          };
          const timer = setTimeout(() => finish(client, true), 5_000);
          client.backpressure = { timer, drain };
          raw.once('drain', drain);
        }
        return true;
      }
    } catch {
      /* A disconnect can race any write. */
    }
    finish(client, true);
    return false;
  }
  function frame(client: Subscriber, event: string, data: unknown, id?: string, prefix = '') {
    return write(
      client,
      `${prefix}${id === undefined ? '' : `id: ${encodeURIComponent(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }
  async function deliver(client: Subscriber, read: Promise<ProjectEventPage>) {
    client.reading = true;
    try {
      const page = await read;
      if (stopping || !subscribers.has(client)) return;
      if (page.status === 'reset') {
        if (frame(client, 'reset', { reason: 'cursor_unavailable' }, page.cursor ?? ''))
          client.cursor = page.cursor;
      } else {
        for (const event of page.events) {
          if (!frame(client, 'control-event', event, event.id)) break;
          client.cursor = event.id;
          if (client.backpressure) break;
        }
      }
      if (
        subscribers.has(client) &&
        !client.backpressure &&
        Date.now() - client.heartbeatAt >= 15_000
      ) {
        if (write(client, ': heartbeat\n\n')) client.heartbeatAt = Date.now();
      }
    } catch {
      if (subscribers.has(client)) {
        frame(client, 'unavailable', { reason: 'event_read_failed' });
        finish(client);
      }
    } finally {
      client.reading = false;
    }
  }
  function poll() {
    if (stopping) return;
    const pages = new Map<string, Promise<ProjectEventPage>>();
    for (const client of subscribers) {
      if (client.reading || client.backpressure) continue;
      const key = JSON.stringify([client.projectId, client.cursor]);
      let read = pages.get(key);
      if (!read) {
        read = Promise.resolve()
          .then(() =>
            reader.readAfter(client.projectId, {
              ...(client.cursor === undefined ? {} : { after: client.cursor }),
              limit: PROJECT_EVENT_PAGE_LIMIT,
            }),
          )
          .then((result) => {
            const page = ProjectEventPageSchema.parse(result);
            if (
              page.status === 'events' &&
              page.events.some((event) => event.projectId !== client.projectId)
            )
              throw new Error('Event reader returned another project.');
            return page;
          });
        pages.set(key, read);
      }
      // Each subscriber has at most one read in flight; one stalled project cannot block another.
      void deliver(client, read);
    }
  }

  app.get('/api/projects/:id/events/stream', async (request, reply) => {
    if (stopping) return reply.code(503).send({ error: 'Server is stopping.' });
    if (subscribers.size + opening >= 16)
      return reply.code(429).send({ error: 'Too many event streams.' });
    let projectId: string, cursor: string | undefined;
    try {
      projectId = z
        .string()
        .min(1)
        .max(128)
        .parse((request.params as { id: string }).id);
      const query = Query.parse(request.query);
      const raw = z
        .string()
        .max(1024)
        .optional()
        .parse(request.headers['last-event-id'] ?? query.after);
      cursor = raw ? decodeURIComponent(raw) : undefined;
    } catch {
      return reply.code(400).send({ error: 'Invalid event cursor or project.' });
    }
    let latest: string | undefined;
    opening++;
    try {
      latest = ProjectEventNoticeSchema.shape.id.optional().parse(await reader.latest(projectId));
    } catch (error) {
      return reply
        .code((error as { statusCode?: number } | null)?.statusCode === 404 ? 404 : 500)
        .send({ error: 'Project events unavailable.' });
    } finally {
      opening--;
    }
    if (stopping) return reply.code(503).send({ error: 'Server is stopping.' });
    if (reply.raw.destroyed) return;
    const client: Subscriber = {
      projectId,
      reply,
      heartbeatAt: Date.now(),
      cursor: cursor ?? latest,
      reading: false,
    };
    reply.hijack();
    subscribers.add(client);
    const onError = () => finish(client, true);
    reply.raw.on('error', onError);
    reply.raw.once('close', () => {
      remove(client);
      reply.raw.off('error', onError);
    });
    try {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
    } catch {
      finish(client, true);
      return;
    }
    // A reconnect must not advance Last-Event-ID until its gap has been replayed.
    if (
      !frame(
        client,
        'ready',
        { projectId },
        cursor === undefined ? client.cursor : undefined,
        'retry: 1000\n\n',
      )
    )
      return;
    poll();
    if (subscribers.size && !timer) timer = setInterval(poll, 500);
  });
  app.addHook('preClose', async () => {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const client of subscribers) finish(client, !!client.backpressure);
  });
}
