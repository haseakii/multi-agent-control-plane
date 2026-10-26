import { z } from 'zod';
import { RuntimeDefinitionSchema } from './domain.js';
import { AgentCatalogSourceInputSchema } from './agent-catalog-source.js';

const Id = z.string().trim().min(1).max(128);
export const ExternalClientAccessSchema = z
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
            workspaceConfirmation: z
              .object({ workspaceId: Id, rootPath: z.string().min(1).max(4096), version: Id })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    tools: z
      .array(
        z.enum([
          'collaboration_list_projects',
          'collaboration_list_agents',
          'collaboration_list_tasks',
          'collaboration_submit_task',
          'collaboration_get_task',
          'collaboration_continue_task',
          'collaboration_cancel_task',
          'collaboration_get_artifact',
          'collaboration_prepare_review',
        ]),
      )
      .min(1),
  })
  .strict();
export const ExternalClientTargetSchema = z.enum(['codex', 'cursor', 'vscode', 'idea', 'generic']);
export const ExternalClientRecordSchema = z
  .object({
    id: Id,
    access: ExternalClientAccessSchema,
    target: ExternalClientTargetSchema,
    profile: z.enum(['read', 'collaborate']),
    requestId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
    configuredAt: z.string().datetime().optional(),
    revision: z.number().int().positive().default(1),
    lastUpdate: z
      .object({ requestId: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.id === value.access.id, 'Client identity mismatch');
export type ExternalClientRecord = z.infer<typeof ExternalClientRecordSchema>;

export const InstalledAgentPackageSchema = z
  .object({
    runtime: RuntimeDefinitionSchema,
    source: AgentCatalogSourceInputSchema,
    origin: z.enum(['installation', 'registered-entry']),
  })
  .strict();
export type InstalledAgentPackage = z.infer<typeof InstalledAgentPackageSchema>;
export const AgentMemberOriginSchema = z
  .object({
    id: Id,
    requestId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceAgentId: Id.optional(),
    installationId: z.string().uuid().optional(),
    runtimeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((value) => !!value.sourceAgentId !== !!value.installationId, 'Choose one member source');
export type AgentMemberOrigin = z.infer<typeof AgentMemberOriginSchema>;

export const AgentInstallationSchema = z
  .object({
    id: z.string().uuid(),
    entryId: Id,
    version: Id,
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum([
      'queued',
      'downloading',
      'installing',
      'checking',
      'ready',
      'failed',
      'needs-attention',
    ]),
    message: z.string().max(1000),
    directory: z.string().min(1).max(32768).optional(),
    agentId: Id.optional(),
    package: InstalledAgentPackageSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AgentInstallation = z.infer<typeof AgentInstallationSchema>;
