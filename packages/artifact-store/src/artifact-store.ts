import { ArtifactIdSchema, ArtifactSchema } from '@control-plane/core';
import type { Artifact } from '@control-plane/core';
import {
  ArtifactLinkSchema,
  ArtifactLinkTargetSchema,
  ArtifactStoreError,
  PublishArtifactInputSchema,
  type ArtifactBlobStore,
  type ArtifactLink,
  type ArtifactLinkTarget,
  type ArtifactMetadataStore,
  type ArtifactStoreOptions,
  type LoadedArtifact,
  type PublishedArtifact,
  type PublishArtifactInput,
} from './types.js';

export class ArtifactStore {
  constructor(
    private readonly blobs: ArtifactBlobStore,
    private readonly metadata: ArtifactMetadataStore,
    private readonly options: ArtifactStoreOptions,
  ) {}

  async publish(input: PublishArtifactInput): Promise<PublishedArtifact> {
    const parsed = PublishArtifactInputSchema.parse(input);
    const blob = await this.blobs.put(parsed.content);
    const now = this.options.now();
    const artifact = ArtifactSchema.parse({
      id: ArtifactIdSchema.parse(this.options.idFactory('artifact')),
      projectId: parsed.projectId,
      taskId: parsed.taskId,
      assignmentId: parsed.assignmentId,
      producerAgentId: parsed.producerAgentId,
      kind: parsed.kind,
      sha256: blob.sha256,
      mimeType: parsed.mimeType,
      sizeBytes: blob.sizeBytes,
      storageKey: blob.storageKey,
      createdAt: now,
    });

    const links = this.metadata.transaction(() => {
      const saved = this.metadata.saveArtifact(artifact);
      return parsed.links.map((target) => this.persistLink(saved, target, now));
    });

    return {
      artifact,
      links,
      deduplicated: blob.deduplicated,
    };
  }

  async load(id: string): Promise<LoadedArtifact> {
    const artifact = this.requireArtifact(id);
    const content = await this.blobs.read(artifact.storageKey);
    if (content.byteLength !== artifact.sizeBytes) {
      throw new ArtifactStoreError(
        'BLOB_INTEGRITY',
        `Artifact size does not match metadata: ${artifact.id}`,
      );
    }
    return {
      artifact,
      links: this.metadata.listLinks(artifact.id),
      content,
    };
  }

  link(id: string, targetInput: ArtifactLinkTarget): ArtifactLink {
    const artifact = this.requireArtifact(id);
    const target = ArtifactLinkTargetSchema.parse(targetInput);
    return this.metadata.transaction(() => this.persistLink(artifact, target, this.options.now()));
  }

  getMetadata(id: string): Artifact {
    return this.requireArtifact(id);
  }

  listLinks(id: string): ArtifactLink[] {
    this.requireArtifact(id);
    return this.metadata.listLinks(id);
  }

  private requireArtifact(id: string): Artifact {
    const artifactId = ArtifactIdSchema.parse(id);
    const artifact = this.metadata.getArtifact(artifactId);
    if (!artifact) {
      throw new ArtifactStoreError('ARTIFACT_NOT_FOUND', `Artifact not found: ${id}`);
    }
    return artifact;
  }

  private persistLink(
    artifact: Artifact,
    target: ArtifactLinkTarget,
    createdAt: string,
  ): ArtifactLink {
    const link = ArtifactLinkSchema.parse({
      id: this.options.idFactory('link'),
      artifactId: artifact.id,
      projectId: artifact.projectId,
      entityType: target.entityType,
      entityId: target.entityId,
      createdAt,
    });
    return this.metadata.upsertLink(link);
  }
}
