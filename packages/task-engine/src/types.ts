import type {
  AgentMessage,
  Approval,
  Artifact,
  Assignment,
  AuditEvent,
  ConversationRef,
  ExecutionAttempt,
  Project,
  Task,
} from '@control-plane/core';

export interface EntityRepository<T extends { id: string }> {
  upsert(value: unknown): T;
  get(id: string): T | undefined;
  list(): T[];
  delete(id: string): boolean;
}

export interface EventRepository {
  append(value: unknown): AuditEvent;
  get(id: string): AuditEvent | undefined;
  listByProject(projectId: string): AuditEvent[];
}

export interface TaskEngineStore {
  projects: EntityRepository<Project>;
  tasks: EntityRepository<Task>;
  assignments: EntityRepository<Assignment>;
  executionAttempts: EntityRepository<ExecutionAttempt>;
  conversations: EntityRepository<ConversationRef>;
  messages?: EntityRepository<AgentMessage>;
  artifacts?: EntityRepository<Artifact>;
  approvals?: EntityRepository<Approval>;
  events: EventRepository;
  transaction<T>(operation: () => T): T;
}

export type TaskEngineOptions = {
  now?: () => string;
  idFactory?: (kind: 'attempt' | 'event') => string;
};

export type CreateTaskInput = {
  id: string;
  projectId: string;
  parentTaskId?: string;
  title: string;
  objective: string;
  state?: 'draft' | 'planning' | 'ready';
  dependencyIds?: string[];
  contextRefs?: string[];
};

export type CreateAssignmentInput = {
  id: string;
  taskId: string;
  agentId: string;
  objective: string;
  role?: {
    name: string;
    description?: string;
  };
};

export type CreateAttemptInput = {
  id?: string;
  runnerId?: string;
};

export type AttachConversationInput = {
  id: string;
  executionAttemptId: string;
  runnerId: string;
  protocol: string;
  sessionId: string;
};

export type FinishAttemptInput =
  | { outcome: 'completed' }
  | {
      outcome: 'failed';
      failure: {
        code: string;
        message: string;
        retryable: boolean;
      };
    }
  | { outcome: 'cancelled' };
