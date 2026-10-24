import {
  AgentIdSchema,
  ArtifactIdSchema,
  ArtifactKindSchema,
  AssignmentIdSchema,
  MessageIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
} from '@control-plane/core';
import type { Artifact } from '@control-plane/core';
import { z } from 'zod';

export const ArtifactLinkEntityTypeSchema = z.enum(['task', 'message', 'assignment']);
export type ArtifactLinkEntityType = z.infer<typeof ArtifactLinkEntityTypeSchema>;

export const ArtifactLinkTargetSchema = z.discriminatedUnion('entityType', [
  z
    .object({
      entityType: z.literal('task'),
      entityId: TaskIdSchema,
    })
    .strict(),
  z
    .object({
      entityType: z.literal('message'),
      entityId: MessageIdSchema,
    })
    .strict(),
  z
    .object({
      entityType: z.literal('assignment'),
      entityId: AssignmentIdSchema,
    })
    .strict(),
]);
export type ArtifactLinkTarget = z.infer<typeof ArtifactLinkTargetSchema>;

export const ArtifactLinkSchema = z
  .object({
    id: z.string().min(1).max(128),
    artifactId: ArtifactIdSchema,
    projectId: ProjectIdSchema,
    entityType: ArtifactLinkEntityTypeSchema,
    entityId: z.string().min(1).max(128),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ArtifactLink = z.infer<typeof ArtifactLinkSchema>;

export const PublishArtifactInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    assignmentId: AssignmentIdSchema.optional(),
    producerAgentId: AgentIdSchema.optional(),
    kind: ArtifactKindSchema,
    mimeType: z.string().min(1).max(256),
    content: z.instanceof(Uint8Array),
    links: z.array(ArtifactLinkTargetSchema).default([]),
  })
  .strict();
export type PublishArtifactInput = z.input<typeof PublishArtifactInputSchema>;

/** Local execution guard; never part of the serializable artifact payload. */
export const PublishArtifactOptionsSchema = z
  .object({
    beforeCommit: z.custom<() => void>((value) => typeof value === 'function').optional(),
  })
  .strict();
export type PublishArtifactOptions = z.infer<typeof PublishArtifactOptionsSchema>;

export type BlobWriteResult = {
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  deduplicated: boolean;
};

export interface ArtifactBlobStore {
  put(content: Uint8Array): Promise<BlobWriteResult>;
  read(storageKey: string): Promise<Uint8Array>;
}

export interface ArtifactMetadataStore {
  transaction<T>(operation: () => T): T;
  saveArtifact(artifact: Artifact): Artifact;
  indexText(artifact: Artifact, content: Uint8Array): void;
  getArtifact(id: string): Artifact | undefined;
  upsertLink(link: ArtifactLink): ArtifactLink;
  listLinks(artifactId: string): ArtifactLink[];
}

export type ArtifactStoreIdFactory = (kind: 'artifact' | 'link') => string;

export type ArtifactStoreOptions = {
  now: () => string;
  idFactory: ArtifactStoreIdFactory;
};

export type PublishedArtifact = {
  artifact: Artifact;
  links: ArtifactLink[];
  deduplicated: boolean;
};

export type LoadedArtifact = {
  artifact: Artifact;
  links: ArtifactLink[];
  content: Uint8Array;
};

export class ArtifactStoreError extends Error {
  constructor(
    readonly code:
      | 'ARTIFACT_NOT_FOUND'
      | 'BLOB_NOT_FOUND'
      | 'BLOB_INTEGRITY'
      | 'INVALID_STORAGE_KEY',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}
