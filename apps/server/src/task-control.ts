import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ControlPlaneRuntime } from './runtime-composition.js';

export class TaskControlError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'TaskControlError';
  }
}

export const CreateProjectSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(256),
    description: z.string().max(10_000).optional(),
  })
  .strict();
export const SubmitGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(256).optional(),
    objective: z.string().trim().min(1).max(100_000),
  })
  .strict();
const ApprovalDecisionSchema = z
  .object({ actor: z.string().trim().min(1).max(128).default('local-user') })
  .strict();

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TaskControlError)
    return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError)
    return reply.code(400).send({ error: 'Request validation failed.' });
  if (error instanceof Error && error.name === 'TaskEngineError')
    return reply.code(409).send({ error: error.message });
  return reply.code(500).send({ error: 'Task control request failed.' });
}

export function registerTaskControlRoutes(
  app: FastifyInstance,
  service: ControlPlaneRuntime,
): void {
  app.post('/api/projects', async (request, reply) => {
    try {
      return reply.code(201).send(service.createProject(request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/projects/:id', async (request, reply) => {
    try {
      return service.getProject((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/projects/:id/goals', async (request, reply) => {
    try {
      return reply
        .code(202)
        .send(service.submitGoal((request.params as { id: string }).id, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id', async (request, reply) => {
    try {
      return service.getTask((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/events', async (request, reply) => {
    try {
      return service.taskEvents((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/messages', async (request, reply) => {
    try {
      return service.taskMessages((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/cancel', async (request, reply) => {
    try {
      return await service.cancelTask((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/resume', async (request, reply) => {
    try {
      return reply.code(202).send(service.resumeTask((request.params as { id: string }).id));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/approvals', async (request, reply) => {
    try {
      const query = z
        .object({ state: z.enum(['pending', 'approved', 'rejected', 'expired']).optional() })
        .strict()
        .parse(request.query);
      return service.listApprovals(query.state);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  for (const [action, state] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(`/api/approvals/:id/${action}`, async (request, reply) => {
      try {
        const { actor } = ApprovalDecisionSchema.parse(request.body ?? {});
        return service.decideApproval((request.params as { id: string }).id, state, actor);
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }
  app.get('/api/artifacts/:id', async (request, reply) => {
    try {
      return service.getArtifact((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/artifacts/:id/content', async (request, reply) => {
    try {
      const loaded = await service.loadArtifact((request.params as { id: string }).id);
      return reply
        .header('content-disposition', 'attachment')
        .type(loaded.artifact.mimeType)
        .send(Buffer.from(loaded.content));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
