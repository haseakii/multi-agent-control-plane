import type { FastifyInstance } from 'fastify';
import type { Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const ShutdownOptions = z
  .object({
    drainTimeoutMs: z.number().int().min(1).max(300_000).default(15_000),
  })
  .strict();

export class HttpDrainTimeoutError extends Error {
  readonly code = 'HTTP_DRAIN_TIMEOUT';

  constructor(timeoutMs: number) {
    super(
      `HTTP shutdown exceeded ${timeoutMs}ms. Requests are still draining; ownership must remain until close completes.`,
    );
    this.name = 'HttpDrainTimeoutError';
  }
}

type ShutdownState = { begin: () => void; result?: Promise<void> };
const states = new WeakMap<FastifyInstance, ShutdownState>();

/** Register before listen, so no accepted connection can escape the tracker. */
export function registerHttpShutdown(app: FastifyInstance): void {
  if (states.has(app)) return;
  const connections = new Map<Socket, { pendingResponses: number }>();
  let stopping = false;
  const connection = (socket: Socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    connections.set(socket, { pendingResponses: 0 });
    socket.once('close', () => connections.delete(socket));
  };
  // Run before routing: even a handler that initiates shutdown owns an in-flight
  // request and must not have its connection mistaken for an idle connection.
  const request = (message: IncomingMessage, response: ServerResponse) => {
    const socket = message.socket;
    const state = connections.get(socket);
    if (!state) return;
    state.pendingResponses++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      response.off('finish', settle);
      response.off('close', settle);
      if (connections.get(socket) !== state) return;
      state.pendingResponses--;
      if (stopping && state.pendingResponses === 0 && !socket.destroyed) {
        // Flush bytes already queued by the final response before destroying the
        // connection. Other pipelined responses keep this count above zero.
        socket.destroySoon();
      }
    };
    response.once('finish', settle);
    response.once('close', settle);
  };
  const begin = () => {
    if (stopping) return;
    stopping = true;
    for (const [socket, state] of connections) {
      if (state.pendingResponses === 0) socket.destroySoon();
    }
  };
  app.server.on('connection', connection);
  app.server.prependListener('request', request);
  app.addHook('preClose', async () => {
    begin();
  });
  app.addHook('onClose', async () => {
    app.server.off('connection', connection);
    app.server.off('request', request);
    connections.clear();
  });
  states.set(app, { begin });
}

/** A deadline reports failure; it never aborts an in-flight durable write. */
export function closeHttpServer(
  app: FastifyInstance,
  options: { drainTimeoutMs?: number } = {},
): Promise<void> {
  const { drainTimeoutMs } = ShutdownOptions.parse(options);
  const state = states.get(app);
  if (!state) throw new Error('HTTP shutdown lifecycle was not registered before listen.');
  if (state.result) return state.result;
  // Also close the race before Fastify's asynchronous preClose hooks run.
  state.begin();
  const draining = app.close();
  state.result = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HttpDrainTimeoutError(drainTimeoutMs)),
      drainTimeoutMs,
    );
    void draining.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  return state.result;
}
