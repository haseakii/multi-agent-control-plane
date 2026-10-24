import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuditEvent } from '@control-plane/core';
import { z } from 'zod';

const Query = z.object({ after: z.string().max(1024).optional() }).strict();
const Notice = z
  .object({
    id: z.string(),
    projectId: z.string(),
    taskId: z.string().optional(),
    type: z.string(),
    occurredAt: z.string(),
  })
  .strict();
type Subscriber = {
  projectId: string;
  cursor: string | undefined;
  reply: FastifyReply;
  heartbeatAt: number;
};

/** Durable audit notifications. Payloads/artifacts remain behind the ordinary read APIs. */
export function registerProjectEventStream(
  app: FastifyInstance,
  readEvents: (projectId: string) => AuditEvent[],
) {
  const subscribers = new Set<Subscriber>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  function remove(client: Subscriber) {
    subscribers.delete(client);
    if (!subscribers.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function frame(client: Subscriber, event: string, data: unknown, id?: string) {
    const text = `${id === undefined ? '' : `id: ${encodeURIComponent(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (!client.reply.raw.write(text)) {
      // Bound queued output; EventSource resumes from the last frame actually received.
      client.reply.raw.end();
      remove(client);
      return false;
    }
    return true;
  }
  function poll() {
    const projects = new Map<string, AuditEvent[]>();
    for (const client of subscribers) {
      try {
        let rows = projects.get(client.projectId);
        if (!rows) {
          rows = readEvents(client.projectId);
          projects.set(client.projectId, rows);
        }
        const index =
          client.cursor === undefined ? -1 : rows.findIndex((row) => row.id === client.cursor);
        if (client.cursor !== undefined && index === -1) {
          client.cursor = rows.at(-1)?.id;
          frame(client, 'reset', { reason: 'cursor_unavailable' }, client.cursor ?? '');
          continue;
        }
        for (const row of rows.slice(index + 1, index + 101)) {
          const notice = Notice.parse({
            id: row.id,
            projectId: row.projectId,
            taskId: row.taskId,
            type: row.type,
            occurredAt: row.occurredAt,
          });
          if (!frame(client, 'control-event', notice, row.id)) break;
          client.cursor = row.id;
        }
        if (subscribers.has(client) && Date.now() - client.heartbeatAt >= 15_000) {
          client.heartbeatAt = Date.now();
          if (!client.reply.raw.write(': heartbeat\n\n')) {
            client.reply.raw.end();
            remove(client);
          }
        }
      } catch {
        frame(client, 'unavailable', { reason: 'event_read_failed' });
        client.reply.raw.end();
        remove(client);
      }
    }
  }
  app.get('/api/projects/:id/events/stream', async (request, reply) => {
    if (stopping) return reply.code(503).send({ error: 'Server is stopping.' });
    if (subscribers.size >= 16) return reply.code(429).send({ error: 'Too many event streams.' });
    let projectId: string, rows: AuditEvent[], cursor: string | undefined;
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
    try {
      rows = readEvents(projectId);
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode === 404 ? 404 : 500)
        .send({ error: 'Project events unavailable.' });
    }
    const client: Subscriber = { projectId, reply, heartbeatAt: Date.now(), cursor };
    if (cursor === undefined) client.cursor = rows.at(-1)?.id;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 1000\n\n');
    subscribers.add(client);
    reply.raw.once('close', () => remove(client));
    // With a reconnect cursor, do not advance the browser's ID before replaying the gap.
    frame(client, 'ready', { projectId }, cursor === undefined ? client.cursor : undefined);
    poll();
    if (subscribers.size && !timer) timer = setInterval(poll, 500);
  });
  app.addHook('preClose', async () => {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const client of subscribers) client.reply.raw.end();
    subscribers.clear();
  });
}
