import { randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  ProposeMemorySchema,
  ProjectMemorySchema,
  ReviewMemorySchema,
  type Artifact,
  type AuditEvent,
  type ProjectMemory,
  type Task,
} from '@control-plane/core';

export interface ProjectMemoryStore {
  transaction<T>(operation: () => T): T;
  list(projectId: string): ProjectMemory[];
  get(id: string): ProjectMemory | undefined;
  save(entry: ProjectMemory): ProjectMemory;
  getTask(id: string): Task | undefined;
  getArtifact(id: string): Artifact | undefined;
  audit(event: AuditEvent): void;
}
export class ProjectMemoryError extends Error {}

/** Curation is explicit. Proposal contents are immutable; corrections create a new proposal. */
export class ProjectMemoryService {
  constructor(
    private readonly store: ProjectMemoryStore,
    private readonly now: () => string,
    private readonly newId = () => randomUUID(),
  ) {}

  list(projectId: string): ProjectMemory[] {
    return this.store.list(projectId);
  }

  propose(
    projectId: string,
    raw: unknown,
    proposer: ProjectMemory['proposedBy'] = { type: 'user', id: 'local-operator' },
  ): ProjectMemory {
    const input = ProposeMemorySchema.parse(raw);
    return this.store.transaction(() => {
      if (input.sourceTaskId && this.store.getTask(input.sourceTaskId)?.projectId !== projectId)
        throw new ProjectMemoryError('来源任务不在当前项目中。');
      for (const id of input.sourceArtifactIds)
        if (this.store.getArtifact(id)?.projectId !== projectId)
          throw new ProjectMemoryError('来源产物不在当前项目中。');
      if (input.supersedesId && this.require(projectId, input.supersedesId).status !== 'accepted')
        throw new ProjectMemoryError('只能提案修订已采纳的记忆。');
      const at = this.now();
      const entry = this.store.save(
        ProjectMemorySchema.parse({
          ...input,
          id: 'memory-' + this.newId(),
          projectId,
          status: 'proposed',
          proposedBy: proposer,
          createdAt: at,
          updatedAt: at,
        }),
      );
      this.audit(entry, 'proposed');
      return entry;
    });
  }

  review(projectId: string, memoryId: string, raw: unknown): ProjectMemory {
    const { action } = ReviewMemorySchema.parse(raw);
    return this.store.transaction(() => {
      const previous = this.require(projectId, memoryId);
      const target = { accept: 'accepted', reject: 'rejected', archive: 'archived' } as const;
      if (previous.status === target[action]) return previous;
      if (previous.status !== (action === 'archive' ? 'accepted' : 'proposed'))
        throw new ProjectMemoryError('该记忆状态已变化，请刷新后操作。');
      const at = this.now();
      if (action === 'accept' && previous.supersedesId) {
        const replaced = this.require(projectId, previous.supersedesId);
        if (replaced.status !== 'accepted')
          throw new ProjectMemoryError('原记忆已被修订或归档，请根据最新记录重新提案。');
        const archived = this.store.save({ ...replaced, status: 'archived', updatedAt: at });
        this.audit(archived, 'superseded', previous.id);
      }
      const entry = this.store.save(
        ProjectMemorySchema.parse({
          ...previous,
          status: target[action],
          updatedAt: at,
          reviewedBy: { type: 'user', id: 'local-operator' },
          reviewedAt: at,
        }),
      );
      this.audit(entry, target[action]);
      return entry;
    });
  }

  private require(projectId: string, id: string) {
    const entry = this.store.get(id);
    if (!entry || entry.projectId !== projectId) throw new ProjectMemoryError('项目记忆不存在。');
    return entry;
  }
  private audit(entry: ProjectMemory, action: string, replacementId?: string) {
    this.store.audit(
      AuditEventSchema.parse({
        id: 'event-' + this.newId(),
        projectId: entry.projectId,
        type: 'memory.' + action,
        occurredAt: this.now(),
        actor: action === 'proposed' ? entry.proposedBy : { type: 'user', id: 'local-operator' },
        payload: {
          memoryId: entry.id,
          status: entry.status,
          ...(replacementId ? { replacementId } : {}),
        },
      }),
    );
  }
}
