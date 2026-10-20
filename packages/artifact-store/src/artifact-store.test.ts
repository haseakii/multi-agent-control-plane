import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage, PotentialSecretError } from '@control-plane/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  FilesystemArtifactBlobStore,
  SqliteArtifactMetadataStore,
} from './index.js';

const tempDirectories: string[] = [];
let sequence = 0;
const now = '2026-10-20T02:00:00.000Z';

function createEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-artifacts-'));
  tempDirectories.push(directory);
  const database = join(directory, 'metadata.sqlite');
  const blobs = join(directory, 'artifacts');
  const storage = openSqliteStorage({ filename: database });
  const store = new ArtifactStore(
    new FilesystemArtifactBlobStore(blobs),
    new SqliteArtifactMetadataStore(storage),
    {
      now: () => now,
      idFactory: (kind) => `${kind}-${++sequence}`,
    },
  );
  return { directory, database, blobs, storage, store };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ArtifactStore', () => {
  it('deduplicates identical bytes while retaining independent provenance metadata', async () => {
    const { blobs, storage, store } = createEnvironment();
    const content = new TextEncoder().encode('same immutable bytes');

    const first = await store.publish({
      projectId: 'project-artifacts',
      taskId: 'task-a',
      producerAgentId: 'agent-a',
      kind: 'text',
      mimeType: 'text/plain',
      content,
      links: [{ entityType: 'task', entityId: 'task-a' }],
    });
    const second = await store.publish({
      projectId: 'project-artifacts',
      taskId: 'task-b',
      producerAgentId: 'agent-b',
      kind: 'text',
      mimeType: 'text/plain',
      content,
      links: [{ entityType: 'task', entityId: 'task-b' }],
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.artifact.id).not.toBe(first.artifact.id);
    expect(second.artifact.sha256).toBe(first.artifact.sha256);
    expect(second.artifact.storageKey).toBe(first.artifact.storageKey);
    expect(first.artifact.producerAgentId).toBe('agent-a');
    expect(second.artifact.producerAgentId).toBe('agent-b');

    const digestDirectory = join(blobs, 'sha256', first.artifact.sha256.slice(0, 2));
    expect(readdirSync(digestDirectory)).toEqual([first.artifact.sha256]);
    storage.close();
  });

  it('loads immutable bytes and durable links after a storage restart', async () => {
    const environment = createEnvironment();
    const published = await environment.store.publish({
      projectId: 'project-artifacts',
      taskId: 'task-restart',
      assignmentId: 'assignment-restart',
      producerAgentId: 'agent-worker',
      kind: 'test-report',
      mimeType: 'application/json',
      content: new TextEncoder().encode('{"ok":true}'),
      links: [
        { entityType: 'task', entityId: 'task-restart' },
        { entityType: 'assignment', entityId: 'assignment-restart' },
      ],
    });
    environment.storage.close();

    const reopenedStorage = openSqliteStorage({ filename: environment.database });
    const reopened = new ArtifactStore(
      new FilesystemArtifactBlobStore(environment.blobs),
      new SqliteArtifactMetadataStore(reopenedStorage),
      {
        now: () => now,
        idFactory: (kind) => `${kind}-${++sequence}`,
      },
    );
    const loaded = await reopened.load(published.artifact.id);

    expect(new TextDecoder().decode(loaded.content)).toBe('{"ok":true}');
    expect(loaded.artifact.assignmentId).toBe('assignment-restart');
    expect(loaded.links.map((link) => link.entityType)).toEqual(['task', 'assignment']);
    reopenedStorage.close();
  });

  it('rejects likely secrets before text-like artifacts reach blob or metadata storage', async () => {
    const { blobs, storage, store } = createEnvironment();

    await expect(
      store.publish({
        projectId: 'project-artifacts',
        kind: 'log',
        mimeType: 'text/plain',
        content: new TextEncoder().encode(
          'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
        ),
      }),
    ).rejects.toBeInstanceOf(PotentialSecretError);

    expect(storage.repositories.artifacts.list()).toHaveLength(0);
    expect(() => readdirSync(blobs)).toThrow();
    storage.close();
  });

  it('lets durable tasks and messages reference published artifacts by ID', async () => {
    const { storage, store } = createEnvironment();
    const published = await store.publish({
      projectId: 'project-artifacts',
      kind: 'diff',
      mimeType: 'text/x-diff',
      content: new TextEncoder().encode('diff --git a/a b/a'),
    });

    storage.repositories.tasks.upsert({
      id: 'task-artifact-ref',
      projectId: 'project-artifacts',
      title: 'Use artifact',
      objective: 'Retain result reference',
      state: 'completed',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [published.artifact.id],
      createdAt: now,
      updatedAt: now,
    });
    storage.repositories.messages.upsert({
      id: 'message-artifact-ref',
      projectId: 'project-artifacts',
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'message',
      content: 'See the attached diff.',
      artifactRefs: [published.artifact.id],
      metadata: {},
      createdAt: now,
    });

    expect(storage.repositories.tasks.get('task-artifact-ref')?.resultArtifactRefs).toEqual([
      published.artifact.id,
    ]);
    expect(storage.repositories.messages.get('message-artifact-ref')?.artifactRefs).toEqual([
      published.artifact.id,
    ]);
    storage.close();
  });
});
