import { z } from 'zod';
import {
  SessionSettingValuesSchema,
  InputAttachmentIdsSchema,
  InputAttachmentSchema,
} from '@control-plane/core';

const Id = z.string().trim().min(1).max(128);
const TaskId = z.object({ taskId: Id }).strict();
export const ClientSubmitSchema = z
  .object({
    attachmentIds: InputAttachmentIdsSchema.optional(),
    projectId: Id,
    agentId: Id,
    title: z.string().trim().min(1).max(256).optional(),
    objective: z.string().trim().min(1).max(32_000),
    idempotencyKey: Id,
    sessionSettings: SessionSettingValuesSchema.optional(),
    sessionPresetId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) => value.sessionSettings === undefined || value.sessionPresetId === undefined,
    'Choose sessionSettings or sessionPresetId, not both.',
  );
export const ClientContinueSchema = z
  .object({
    attachmentIds: InputAttachmentIdsSchema.optional(),
    taskId: Id,
    content: z.string().trim().min(1).max(4000),
    idempotencyKey: Id,
    sessionSettings: SessionSettingValuesSchema.optional(),
    sessionPresetId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) => value.sessionSettings === undefined || value.sessionPresetId === undefined,
    'Choose sessionSettings or sessionPresetId, not both.',
  );

/** Paths exist only on the stdio client. The engine receives verified bytes and IDs. */
export const ClientLocalAttachmentsSchema = z
  .array(
    z
      .object({
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => !/[\x00\r\n]/.test(value))
          .describe(
            'Absolute local file path explicitly authorized by the user. No directories, globs, URLs, or credential discovery.',
          ),
        name: InputAttachmentSchema.shape.name.optional(),
        mimeType: z.string().min(1).max(128).optional(),
      })
      .strict(),
  )
  .max(10);
export const ClientMcpSubmitSchema = ClientSubmitSchema.safeExtend({
  attachments: ClientLocalAttachmentsSchema.optional(),
});
export const ClientMcpContinueSchema = ClientContinueSchema.safeExtend({
  attachments: ClientLocalAttachmentsSchema.optional(),
});
export const ClientAttachmentUploadQuerySchema = z
  .object({
    toolName: z.enum(['collaboration_submit_task', 'collaboration_continue_task']),
    projectId: Id.optional(),
    taskId: Id.optional(),
    idempotencyKey: Id,
    slot: z.coerce.number().int().min(0).max(9),
    name: InputAttachmentSchema.shape.name,
    mimeType: z.string().min(1).max(128),
    sha256: InputAttachmentSchema.shape.sha256,
  })
  .strict()
  .refine(
    (value) =>
      value.toolName === 'collaboration_submit_task'
        ? !!value.projectId && !value.taskId
        : !!value.taskId && !value.projectId,
    'Choose the tool target.',
  );

/** Shared validated contract; transport adapters do not own orchestration. */
export const clientToolDefinitions = [
  {
    name: 'collaboration_list_projects',
    description:
      'List authorized projects and their working directories. Choose the project the user intends; existing source directories retain their review/merge workflow.',
    schema: z.object({}).strict(),
    readOnly: true,
  },
  {
    name: 'collaboration_list_agents',
    description:
      'Discover registered collaboration agents, readiness, advertised model controls, saved defaults and named preset IDs. Use projectId and agentId with refreshSettings=true to read real ACP settings without logging in or sending a prompt. Only advertised controls are selectable; permission modes remain unchanged.',
    schema: z
      .object({
        projectId: Id.optional(),
        agentId: Id.optional(),
        refreshSettings: z.boolean().optional(),
      })
      .strict()
      .refine(
        (value) => !value.refreshSettings || !!(value.projectId && value.agentId),
        'Refreshing agent settings requires a projectId and an agentId.',
      ),
    readOnly: true,
  },
  {
    name: 'collaboration_list_tasks',
    description: 'Find durable tasks to continue, including tasks created from the web workbench.',
    schema: z
      .object({ projectId: Id, limit: z.number().int().min(1).max(50).default(20) })
      .strict(),
    readOnly: true,
  },
  {
    name: 'collaboration_submit_task',
    description:
      'Delegate a real task directly to an eligible ACP agent in an authorized project. Choose optional sessionSettings (advertised controls) or sessionPresetId (a named preset from list_agents); accepted tasks copy the values and retain them on retry. Returns promptly with a durable task ID; use get_task to follow progress and confirmed settings. Use a new idempotencyKey per intended submission and reuse it only for retries. Source code is merged only through the existing human review workflow.',
    schema: ClientSubmitSchema,
    readOnly: false,
  },
  {
    name: 'collaboration_get_task',
    description:
      'Read durable status, latestAttempt.failure, recovery guidance, incremental process records, artifacts, usage and review state. Follow nextTaskId when present. Supply the returned cursor; waitMs up to 30000 avoids busy polling. Failure does not discard workspace changes. Pending approvals must be handled by the human in the workbench.',
    schema: TaskId.extend({
      after: Id.optional(),
      limit: z.number().int().min(1).max(100).default(30),
      waitMs: z.number().int().min(0).max(30_000).default(0),
    }).strict(),
    readOnly: true,
  },
  {
    name: 'collaboration_continue_task',
    description:
      'Continue the latest task in the same durable conversation. While running, queues an instruction; after completion, creates a linked new round carrying prior context and confirmed model settings. An explicit sessionSettings or sessionPresetId applies to the next round only. Does not re-delegate completed work. Reuse idempotencyKey only when retrying the same input.',
    schema: ClientContinueSchema,
    readOnly: false,
  },
  {
    name: 'collaboration_cancel_task',
    description: 'Cancel a task and its active child work. Retains history and artifacts.',
    schema: TaskId,
    readOnly: false,
  },
  {
    name: 'collaboration_get_artifact',
    description:
      'Read a bounded text excerpt from a task artifact with its verified metadata. Large outputs stay as artifacts; use offset to continue. Binary content remains available through the workbench.',
    schema: z
      .object({
        artifactId: Id,
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1).max(16_000).default(8000),
      })
      .strict(),
    readOnly: true,
  },
  {
    name: 'collaboration_prepare_review',
    description:
      'Prepare a fixed code diff for human review after execution finishes. Returns changed files and patch artifact. This does not approve, merge, push, or change source files. Ask the human to inspect and approve through the workbench.',
    schema: TaskId,
    readOnly: false,
  },
] as const;
export type ClientToolName = (typeof clientToolDefinitions)[number]['name'];
export const ClientToolNameSchema = z.enum(clientToolDefinitions.map((t) => t.name));
export const ClientToolRequestSchema = z
  .object({ toolName: ClientToolNameSchema, input: z.unknown() })
  .strict();

export const ClientAccessSchema = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
    tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    projects: z
      .array(
        z
          .object({
            projectId: Id,
            // Consent is tied to the registered source identity, not a guessed path.
            workspaceConfirmation: z
              .object({ workspaceId: Id, rootPath: z.string().min(1).max(4096), version: Id })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    tools: z.array(ClientToolNameSchema).min(1),
  })
  .strict();
export type ClientAccess = z.infer<typeof ClientAccessSchema>;
export const ClientAccessFileSchema = z
  .object({ version: z.literal(1), clients: z.array(ClientAccessSchema).max(64) })
  .strict();
