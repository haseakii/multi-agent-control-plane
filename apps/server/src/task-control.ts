import { TaskInstructionError, ProjectMemoryError } from '@control-plane/task-engine';
import { WorkspaceReviewError } from '@control-plane/workspace';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AgentSessionPresetIdSchema,
  ExecutionWorkspaceModeSchema,
  SessionSettingValuesSchema,
} from '@control-plane/core';
import {
  PotentialSecretError,
  SensitiveApprovalReadError,
  ApprovalRecordIntegrityError,
  PermissionInspectionLimitError,
} from '@control-plane/storage';
import { ExistingDirectoryChoiceSchema } from './local-directory-binding.js';
import type { ControlPlaneRuntime } from './runtime-composition.js';
import { registerProjectEventStream } from './project-event-stream.js';

import { TaskControlError } from './task-control-error.js';
import { SessionSettingsError } from './session-settings.js';
export { TaskControlError } from './task-control-error.js';

export const CreateProjectSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(256),
    description: z.string().max(10_000).optional(),
    executionWorkspaceMode: ExecutionWorkspaceModeSchema.optional(),
    workspace: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('managed') }).strict(),
        ExistingDirectoryChoiceSchema,
      ])
      .optional(),
  })
  .strict();
export const WorkspaceConfirmationSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    rootPath: z.string().min(1).max(4096),
    version: z.string().min(1).max(128),
  })
  .strict();
export const ResumeTaskSchema = z
  .object({ workspaceConfirmation: WorkspaceConfirmationSchema.optional() })
  .strict();
export const FollowUpTaskSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    idempotencyKey: z.string().min(1).max(128),
    workspaceConfirmation: WorkspaceConfirmationSchema.optional(),
    sessionSettings: SessionSettingValuesSchema.optional(),
    sessionPresetId: AgentSessionPresetIdSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.sessionSettings === undefined || input.sessionPresetId === undefined,
    'Choose session settings or a preset, not both.',
  );
export const FollowUpLinkSchema = z
  .object({
    sourceTaskId: z.string().min(1),
    conversationRootTaskId: z.string().min(1),
    settingsHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const WorkspaceModeUpdateSchema = z.object({ mode: ExecutionWorkspaceModeSchema }).strict();
export const SubmitGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(256).optional(),
    objective: z.string().trim().min(1).max(100_000),
    workspaceConfirmation: WorkspaceConfirmationSchema.optional(),
    sessionSettings: SessionSettingValuesSchema.optional(),
    sessionPresetId: AgentSessionPresetIdSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.sessionSettings === undefined || input.sessionPresetId === undefined,
    'Choose session settings or a preset, not both.',
  );
const ApprovalDecisionSchema = z
  .object({ actor: z.string().trim().min(1).max(128).default('local-user') })
  .strict();

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof SessionSettingsError)
    return reply
      .code(error.statusCode)
      .send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  if (error instanceof WorkspaceReviewError) return reply.code(409).send({ error: error.message });
  if (error instanceof ProjectMemoryError) return reply.code(409).send({ error: error.message });
  if (error instanceof TaskInstructionError)
    return reply
      .code(error.code === 'INTEGRITY' ? 500 : 409)
      .send({ error: error.message, code: 'INSTRUCTION_' + error.code });
  if (error instanceof SensitiveApprovalReadError)
    return reply
      .code(409)
      .send({ error: 'Approval record is isolated and unavailable.', code: error.code });
  if (
    error instanceof ApprovalRecordIntegrityError ||
    error instanceof PermissionInspectionLimitError
  )
    return reply.code(500).send({ error: 'Approval storage read failed.', code: error.code });
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
  registerProjectEventStream(app, (projectId) => service.projectEvents(projectId));
  const memberSettingsParams = z.object({ id: z.string().min(1).max(128) }).strict();
  const memberSettingsQuery = z
    .object({ projectId: z.string().min(1).max(128).optional() })
    .strict();
  app.get('/api/agents/:id/session-settings', async (request, reply) => {
    try {
      const { id } = memberSettingsParams.parse(request.params);
      const { projectId } = memberSettingsQuery.parse(request.query);
      reply.header('cache-control', 'no-store');
      return service.sessionSettings.read(id, projectId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/agents/:id/session-settings', async (request, reply) => {
    try {
      const { id } = memberSettingsParams.parse(request.params);
      const { projectId, values } = z
        .object({
          projectId: z.string().min(1).max(128).optional(),
          values: SessionSettingValuesSchema.optional(),
        })
        .strict()
        .parse(request.body ?? {});
      return await service.sessionSettings.inspect(id, projectId, values);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.put('/api/agents/:id/session-settings/defaults', async (request, reply) => {
    try {
      const { id } = memberSettingsParams.parse(request.params);
      return service.sessionSettings.saveDefaults(id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/session-settings', async (request, reply) => {
    try {
      const { id } = memberSettingsParams.parse(request.params);
      service.getTask(id);
      reply.header('cache-control', 'no-store');
      return service.sessionSettings.repository.getTask(id) ?? { state: 'unavailable' };
    } catch (error) {
      return sendError(reply, error);
    }
  });
  const presetParams = memberSettingsParams
    .extend({ presetId: AgentSessionPresetIdSchema })
    .strict();
  app.get('/api/agents/:id/session-presets', async (request, reply) => {
    try {
      const { id } = memberSettingsParams.parse(request.params);
      const { includeArchived } = z
        .object({
          includeArchived: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => value === 'true'),
        })
        .strict()
        .parse(request.query);
      reply.header('cache-control', 'no-store');
      return service.sessionSettings.listPresets(id, includeArchived);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/agents/:id/session-presets/:presetId', async (request, reply) => {
    try {
      const { id, presetId } = presetParams.parse(request.params);
      reply.header('cache-control', 'no-store');
      return service.sessionSettings.getPreset(id, presetId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/agents/:id/session-presets', async (request, reply) => {
    try {
      const { id } = memberSettingsParams.parse(request.params);
      return reply.code(201).send(service.sessionSettings.createPreset(id, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.patch('/api/agents/:id/session-presets/:presetId', async (request, reply) => {
    try {
      const { id, presetId } = presetParams.parse(request.params);
      return service.sessionSettings.updatePreset(id, presetId, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  for (const action of ['archive', 'restore'] as const) {
    app.post(`/api/agents/:id/session-presets/:presetId/${action}`, async (request, reply) => {
      try {
        const { id, presetId } = presetParams.parse(request.params);
        return service.sessionSettings.archivePreset(
          id,
          presetId,
          request.body,
          action === 'restore',
        );
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }
  app.get('/api/tasks/:id/recovery', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
      return service.taskRecovery(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/projects/:id/tasks', async (request, reply) => {
    try {
      return reply
        .code(201)
        .send(service.createDraft((request.params as { id: string }).id, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/record', async (request, reply) => {
    try {
      return service.taskRecords.inspect((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.patch('/api/tasks/:id', async (request, reply) => {
    try {
      return service.taskRecords.update((request.params as { id: string }).id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.delete('/api/tasks/:id', async (request, reply) => {
    try {
      return service.taskRecords.delete((request.params as { id: string }).id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/start', async (request, reply) => {
    try {
      return service.startDraft((request.params as { id: string }).id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/projects/:id/policy', async (request, reply) => {
    try {
      return service.getProjectPolicy((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.put('/api/projects/:id/policy', async (request, reply) => {
    try {
      return service.setProjectPolicy((request.params as { id: string }).id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/workspace-reviews', async (request, reply) => {
    try {
      return service.listWorkspaceReviews((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/live-changes', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
      reply.header('cache-control', 'no-store');
      return await service.readLiveChanges(id, request.query);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/page-preview', async (request, reply) => {
    try {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return await service.captureWorkspacePage((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/live-preview', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
      return await service.startLivePreview(id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/live-preview/:previewId', async (request, reply) => {
    try {
      const { id, previewId } = z
        .object({ id: z.string().min(1).max(128), previewId: z.string().uuid() })
        .parse(request.params);
      return await service.livePreviewStatus(id, previewId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/live-preview/:previewId/document', async (request, reply) => {
    try {
      const { id, previewId } = z
        .object({ id: z.string().min(1).max(128), previewId: z.string().uuid() })
        .parse(request.params);
      reply.header('cache-control', 'no-store');
      return await service.livePreviewDocument(id, previewId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/workspace-cleanup', async (request, reply) => {
    try {
      return await service.previewWorkspaceCleanup((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-cleanup', async (request, reply) => {
    try {
      return await service.executeWorkspaceCleanup(
        (request.params as { id: string }).id,
        request.body,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-cleanup/check', async (request, reply) => {
    try {
      return await service.recoverWorkspaceCleanup(
        (request.params as { id: string }).id,
        request.body,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/workspace-pushes', async (request, reply) => {
    try {
      return service.listWorkspacePushes((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/workspace-reviews/:reviewId/push-remotes', async (request, reply) => {
    try {
      const { id, reviewId } = request.params as { id: string; reviewId: string };
      return await service.listPushRemotes(id, reviewId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-reviews/:reviewId/pushes', async (request, reply) => {
    try {
      const { id, reviewId } = request.params as { id: string; reviewId: string };
      return reply.code(201).send(await service.prepareWorkspacePush(id, reviewId, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-pushes/:pushId/decision', async (request, reply) => {
    try {
      const { id, pushId } = request.params as { id: string; pushId: string };
      const { state } = z
        .object({ state: z.enum(['approved', 'rejected']) })
        .strict()
        .parse(request.body);
      return service.decideWorkspacePush(id, pushId, state);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-pushes/:pushId/execute', async (request, reply) => {
    try {
      const { id, pushId } = request.params as { id: string; pushId: string };
      return await service.executeWorkspacePush(id, pushId, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-pushes/:pushId/check', async (request, reply) => {
    try {
      const { id, pushId } = request.params as { id: string; pushId: string };
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return await service.checkWorkspacePush(id, pushId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-reviews', async (request, reply) => {
    try {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return reply
        .code(201)
        .send(await service.prepareWorkspaceReview((request.params as { id: string }).id));
    } catch (error) {
      if (error instanceof PotentialSecretError)
        return reply.code(400).send({ error: '变更中包含疑似凭据，未生成审阅；请移除后重试。' });
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-reviews/:reviewId/decision', async (request, reply) => {
    try {
      const { state } = z
        .object({ state: z.enum(['approved', 'rejected']) })
        .strict()
        .parse(request.body);
      const { id, reviewId } = request.params as { id: string; reviewId: string };
      return service.decideWorkspaceReview(id, reviewId, state);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/workspace-reviews/:reviewId/merge', async (request, reply) => {
    try {
      const { id, reviewId } = request.params as { id: string; reviewId: string };
      return await service.mergeWorkspaceReview(id, reviewId, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/projects/:id/memory', async (request, reply) => {
    try {
      return service.listMemory((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/projects/:id/memory', async (request, reply) => {
    try {
      return reply
        .code(201)
        .send(service.proposeMemory((request.params as { id: string }).id, request.body));
    } catch (error) {
      if (error instanceof PotentialSecretError)
        return reply.code(400).send({ error: '记忆包含疑似凭据，未保存；请移除后重试。' });
      return sendError(reply, error);
    }
  });
  app.post('/api/projects/:id/memory/:memoryId/review', async (request, reply) => {
    try {
      const { id, memoryId } = request.params as { id: string; memoryId: string };
      return service.reviewMemory(id, memoryId, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/projects/:id/knowledge', async (request, reply) => {
    try {
      return await service.searchContext((request.params as { id: string }).id, request.query);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/directories/validate', async (request, reply) => {
    try {
      return service.previewExistingDirectory(request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
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
  app.put('/api/projects/:id/workspace-mode', async (request, reply) => {
    try {
      return service.setWorkspaceMode((request.params as { id: string }).id, request.body);
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
  app.get('/api/tasks/:id/message-deliveries', async (request, reply) => {
    try {
      return service.taskMessageDeliveries((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/instructions', async (request, reply) => {
    try {
      return service.readTaskInstructions((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/instructions', async (request, reply) => {
    try {
      return reply
        .code(202)
        .send(service.submitTaskInstruction((request.params as { id: string }).id, request.body));
    } catch (error) {
      if (error instanceof PotentialSecretError)
        return reply
          .code(400)
          .send({ error: '补充中包含疑似凭据，未保存；请移除后重试。', code: 'POTENTIAL_SECRET' });
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/follow-ups', async (request, reply) => {
    try {
      return reply
        .code(202)
        .send(service.followUpTask((request.params as { id: string }).id, request.body));
    } catch (error) {
      if (error instanceof PotentialSecretError)
        return reply.code(400).send({ error: '追问中包含疑似凭据，未保存；请移除后重试。' });
      return sendError(reply, error);
    }
  });
  app.get('/api/tasks/:id/chat-receipts/:key', async (request, reply) => {
    try {
      const params = z
        .object({ id: z.string().min(1).max(128), key: z.string().min(1).max(128) })
        .strict()
        .parse(request.params);
      return service.readConversationInput(params.id, params.key);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/tasks/:id/chat', async (request, reply) => {
    try {
      return reply
        .code(202)
        .send(service.submitConversationInput((request.params as { id: string }).id, request.body));
    } catch (error) {
      if (error instanceof PotentialSecretError)
        return reply.code(400).send({ error: '消息中包含疑似凭据，未保存；请移除后重试。' });
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
      return reply
        .code(202)
        .send(service.resumeTask((request.params as { id: string }).id, request.body ?? {}));
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
      const result = service.readApprovals(query.state);
      reply.header('x-control-plane-approval-isolation-code', result.diagnostics.code);
      reply.header('x-control-plane-approval-isolation-count', String(result.diagnostics.count));
      return result.approvals;
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
