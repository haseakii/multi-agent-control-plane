import { randomUUID } from 'node:crypto';
import {
  AgentIdSchema,
  AssignmentSchema,
  AuditEventSchema,
  ConversationRefSchema,
  ExecutionAttemptSchema,
  ProjectIdSchema,
  RunnerIdSchema,
  TaskIdSchema,
  TaskSchema,
  type Assignment,
  type ExecutionAttempt,
  type Task,
  type TaskState,
} from '@control-plane/core';
import type {
  AttachConversationInput,
  CreateAssignmentInput,
  CreateAttemptInput,
  CreateTaskInput,
  FinishAttemptInput,
  TaskEngineOptions,
  TaskEngineStore,
} from './types.js';

const terminalTaskStates = new Set<TaskState>(['completed', 'failed', 'cancelled']);

const allowedTransitions: Record<TaskState, ReadonlySet<TaskState>> = {
  draft: new Set(['planning', 'ready', 'cancelled']),
  planning: new Set(['ready', 'blocked', 'failed', 'cancelled']),
  ready: new Set(['running', 'blocked', 'cancelled']),
  running: new Set(['waiting', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled']),
  waiting: new Set(['ready', 'running', 'blocked', 'failed', 'cancelled', 'completed']),
  waiting_approval: new Set(['ready', 'running', 'blocked', 'failed', 'cancelled']),
  blocked: new Set(['ready', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export class TaskEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskEngineError';
  }
}

export class TaskEngine {
  private readonly now: () => string;
  private readonly idFactory: (kind: 'attempt' | 'event') => string;

  constructor(
    private readonly store: TaskEngineStore,
    options: TaskEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  createTask(input: CreateTaskInput): Task {
    return this.store.transaction(() => {
      const now = this.now();
      const task = TaskSchema.parse({
        id: input.id,
        projectId: input.projectId,
        ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
        title: input.title,
        objective: input.objective,
        state: input.state ?? 'draft',
        dependencyIds: input.dependencyIds ?? [],
        contextRefs: input.contextRefs ?? [],
        resultArtifactRefs: [],
        createdAt: now,
        updatedAt: now,
      });

      if (this.store.tasks.get(task.id)) {
        throw new TaskEngineError('TASK_EXISTS', `Task already exists: ${task.id}`);
      }
      this.requireProject(task.projectId);
      this.validateParent(task);
      this.validateDependencies(task.id, task.projectId, task.dependencyIds);
      if (task.state === 'ready') {
        this.assertDependenciesCompleted(task);
      }

      this.store.tasks.upsert(task);
      this.appendEvent(task, 'task.created', { state: task.state });
      return task;
    });
  }

  getTask(taskId: string): Task {
    return this.requireTask(TaskIdSchema.parse(taskId));
  }

  listChildren(taskId: string): Task[] {
    const parsed = TaskIdSchema.parse(taskId);
    return this.store.tasks.list().filter((task) => task.parentTaskId === parsed);
  }

  listReady(projectId: string): Task[] {
    const parsedProject = ProjectIdSchema.parse(projectId);
    return this.store.tasks
      .list()
      .filter(
        (task) =>
          task.projectId === parsedProject &&
          task.state === 'ready' &&
          this.dependenciesCompleted(task),
      );
  }

  setDependencies(taskId: string, dependencyIds: string[]): Task {
    return this.store.transaction(() => {
      const task = this.requireTask(TaskIdSchema.parse(taskId));
      if (terminalTaskStates.has(task.state) || task.state === 'running') {
        throw new TaskEngineError(
          'TASK_DEPENDENCIES_LOCKED',
          `Cannot change dependencies while task is ${task.state}.`,
        );
      }

      const parsedDependencies = dependencyIds.map((id) => TaskIdSchema.parse(id));
      this.validateDependencies(task.id, task.projectId, parsedDependencies);
      const updated = TaskSchema.parse({
        ...task,
        dependencyIds: parsedDependencies,
        updatedAt: this.now(),
      });
      if (updated.state === 'ready') {
        this.assertDependenciesCompleted(updated);
      }

      this.store.tasks.upsert(updated);
      this.appendEvent(updated, 'task.dependencies_changed', {
        dependencyIds: [...updated.dependencyIds],
      });
      return updated;
    });
  }

  transitionTask(taskId: string, nextState: TaskState): Task {
    return this.store.transaction(() => {
      const task = this.requireTask(TaskIdSchema.parse(taskId));
      return this.transitionTaskWithin(task, nextState);
    });
  }

  completeTask(taskId: string, resultArtifactRefs?: string[]): Task {
    return this.store.transaction(() => {
      let task = this.requireTask(TaskIdSchema.parse(taskId));
      if (resultArtifactRefs !== undefined) {
        task = TaskSchema.parse({
          ...task,
          resultArtifactRefs,
          updatedAt: this.now(),
        });
        this.store.tasks.upsert(task);
      }
      return this.transitionTaskWithin(task, 'completed');
    });
  }

  createAssignment(input: CreateAssignmentInput): Assignment {
    return this.store.transaction(() => {
      const task = this.requireTask(TaskIdSchema.parse(input.taskId));
      if (terminalTaskStates.has(task.state)) {
        throw new TaskEngineError(
          'TASK_TERMINAL',
          `Cannot assign work to terminal task ${task.id}.`,
        );
      }
      if (this.store.assignments.get(input.id)) {
        throw new TaskEngineError('ASSIGNMENT_EXISTS', `Assignment already exists: ${input.id}`);
      }

      const now = this.now();
      const assignment = AssignmentSchema.parse({
        id: input.id,
        taskId: task.id,
        agentId: input.agentId,
        ...(input.role === undefined ? {} : { role: input.role }),
        objective: input.objective,
        state: 'queued',
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      });
      this.store.assignments.upsert(assignment);
      this.appendEvent(task, 'assignment.created', {
        assignmentId: assignment.id,
        agentId: assignment.agentId,
      });
      return assignment;
    });
  }

  createAttempt(assignmentId: string, input: CreateAttemptInput = {}): ExecutionAttempt {
    return this.store.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      return this.createAttemptWithin(assignment, input);
    });
  }

  startAttempt(attemptId: string): ExecutionAttempt {
    return this.store.transaction(() => {
      const attempt = this.requireAttempt(attemptId);
      if (attempt.state !== 'queued') {
        throw new TaskEngineError(
          'ATTEMPT_NOT_QUEUED',
          `Attempt ${attempt.id} is ${attempt.state}, not queued.`,
        );
      }

      const assignment = this.requireAssignment(attempt.assignmentId);
      let task = this.requireTask(attempt.taskId);
      if (task.state === 'ready' || task.state === 'waiting') {
        task = this.transitionTaskWithin(task, 'running');
      } else if (task.state !== 'running') {
        throw new TaskEngineError(
          'TASK_NOT_RUNNABLE',
          `Task ${task.id} cannot start an attempt while ${task.state}.`,
        );
      }

      const now = this.now();
      const running = ExecutionAttemptSchema.parse({
        ...attempt,
        state: 'running',
        startedAt: now,
        updatedAt: now,
      });
      const runningAssignment = AssignmentSchema.parse({
        ...assignment,
        state: 'running',
        updatedAt: now,
      });

      this.store.executionAttempts.upsert(running);
      this.store.assignments.upsert(runningAssignment);
      this.appendEvent(task, 'attempt.started', {
        assignmentId: assignment.id,
        attemptId: running.id,
        attemptNumber: running.number,
      });
      return running;
    });
  }

  attachConversation(input: AttachConversationInput) {
    return this.store.transaction(() => {
      const attempt = this.requireAttempt(input.executionAttemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      if (this.store.conversations.get(input.id)) {
        throw new TaskEngineError(
          'CONVERSATION_EXISTS',
          `Conversation reference already exists: ${input.id}`,
        );
      }

      const conversation = ConversationRefSchema.parse({
        id: input.id,
        taskId: attempt.taskId,
        assignmentId: attempt.assignmentId,
        executionAttemptId: attempt.id,
        agentId: assignment.agentId,
        runnerId: input.runnerId,
        protocol: input.protocol,
        sessionId: input.sessionId,
        createdAt: this.now(),
      });
      this.store.conversations.upsert(conversation);
      const task = this.requireTask(attempt.taskId);
      this.appendEvent(task, 'conversation.attached', {
        assignmentId: assignment.id,
        attemptId: attempt.id,
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
      });
      return conversation;
    });
  }

  listAttempts(assignmentId: string): ExecutionAttempt[] {
    const assignment = this.requireAssignment(assignmentId);
    return this.store.executionAttempts
      .list()
      .filter((attempt) => attempt.assignmentId === assignment.id)
      .sort((left, right) => left.number - right.number);
  }

  listConversations(attemptId: string) {
    const attempt = this.requireAttempt(attemptId);
    return this.store.conversations
      .list()
      .filter((conversation) => conversation.executionAttemptId === attempt.id);
  }

  finishAttempt(attemptId: string, input: FinishAttemptInput): ExecutionAttempt {
    return this.store.transaction(() => {
      const attempt = this.requireAttempt(attemptId);
      if (!['running', 'waiting'].includes(attempt.state)) {
        throw new TaskEngineError(
          'ATTEMPT_NOT_ACTIVE',
          `Attempt ${attempt.id} is ${attempt.state}, not active.`,
        );
      }

      const assignment = this.requireAssignment(attempt.assignmentId);
      let task = this.requireTask(attempt.taskId);
      const now = this.now();
      const state = input.outcome;
      const finished = ExecutionAttemptSchema.parse({
        ...attempt,
        state,
        updatedAt: now,
        finishedAt: now,
        ...(input.outcome === 'failed' ? { failure: input.failure } : {}),
      });
      const assignmentState =
        state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'cancelled';
      const updatedAssignment = AssignmentSchema.parse({
        ...assignment,
        state: assignmentState,
        updatedAt: now,
      });

      this.store.executionAttempts.upsert(finished);
      this.store.assignments.upsert(updatedAssignment);

      if (state === 'failed' && !terminalTaskStates.has(task.state)) {
        task = this.transitionTaskWithin(task, 'failed');
      } else if ((state === 'completed' || state === 'cancelled') && task.state === 'running') {
        task = this.transitionTaskWithin(task, 'waiting');
      }

      this.appendEvent(task, 'attempt.finished', {
        assignmentId: assignment.id,
        attemptId: finished.id,
        attemptNumber: finished.number,
        outcome: state,
      });
      return finished;
    });
  }

  retryAssignment(assignmentId: string, input: CreateAttemptInput = {}): ExecutionAttempt {
    return this.store.transaction(() => {
      let assignment = this.requireAssignment(assignmentId);
      const attempts = this.listAttempts(assignment.id);
      const latest = attempts.at(-1);
      if (!latest || !['failed', 'interrupted'].includes(latest.state)) {
        throw new TaskEngineError(
          'ATTEMPT_NOT_RETRYABLE',
          `Assignment ${assignment.id} has no failed/interrupted attempt to retry.`,
        );
      }
      if (latest.state === 'failed' && latest.failure?.retryable === false) {
        throw new TaskEngineError(
          'ATTEMPT_NOT_RETRYABLE',
          `Attempt ${latest.id} is marked non-retryable.`,
        );
      }

      let task = this.requireTask(assignment.taskId);
      if (task.state === 'completed' || task.state === 'cancelled') {
        throw new TaskEngineError(
          'TASK_TERMINAL',
          `Cannot retry assignment for terminal task ${task.id}.`,
        );
      }
      if (task.state === 'failed' || task.state === 'waiting' || task.state === 'blocked') {
        this.assertDependenciesCompleted(task);
        task = TaskSchema.parse({ ...task, state: 'ready', updatedAt: this.now() });
        this.store.tasks.upsert(task);
        this.appendEvent(task, 'task.retry_requested', {
          assignmentId: assignment.id,
          previousAttemptId: latest.id,
        });
      }

      assignment = AssignmentSchema.parse({
        ...assignment,
        state: 'queued',
        updatedAt: this.now(),
      });
      this.store.assignments.upsert(assignment);
      return this.createAttemptWithin(assignment, input);
    });
  }

  cancelTask(taskId: string, options: { cascade?: boolean } = {}): Task {
    return this.store.transaction(() => {
      const root = this.requireTask(TaskIdSchema.parse(taskId));
      const targets = options.cascade === false ? [root] : this.collectTaskSubtree(root);
      const now = this.now();

      for (const task of targets.reverse()) {
        if (task.state === 'completed' || task.state === 'cancelled') {
          continue;
        }

        for (const assignment of this.store.assignments
          .list()
          .filter((candidate) => candidate.taskId === task.id)) {
          if (!['completed', 'failed', 'cancelled'].includes(assignment.state)) {
            this.store.assignments.upsert(
              AssignmentSchema.parse({
                ...assignment,
                state: 'cancelled',
                updatedAt: now,
              }),
            );
          }

          for (const attempt of this.store.executionAttempts
            .list()
            .filter((candidate) => candidate.assignmentId === assignment.id)) {
            if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(attempt.state)) {
              this.store.executionAttempts.upsert(
                ExecutionAttemptSchema.parse({
                  ...attempt,
                  state: 'cancelled',
                  updatedAt: now,
                  finishedAt: now,
                }),
              );
            }
          }
        }

        const cancelled = TaskSchema.parse({
          ...task,
          state: 'cancelled',
          updatedAt: now,
        });
        this.store.tasks.upsert(cancelled);
        this.appendEvent(cancelled, 'task.cancelled', { cascade: options.cascade !== false });
      }

      return this.requireTask(root.id);
    });
  }

  recoverInterruptedAttempts(): ExecutionAttempt[] {
    return this.store.transaction(() => {
      const recovered: ExecutionAttempt[] = [];
      for (const attempt of this.store.executionAttempts
        .list()
        .filter((candidate) => ['queued', 'running', 'waiting'].includes(candidate.state))) {
        const now = this.now();
        const interrupted = ExecutionAttemptSchema.parse({
          ...attempt,
          state: 'interrupted',
          updatedAt: now,
          finishedAt: now,
          failure: {
            code: 'CONTROL_PLANE_RESTART',
            message: 'The control plane restarted before this attempt finished.',
            retryable: true,
          },
        });
        this.store.executionAttempts.upsert(interrupted);

        const assignment = this.requireAssignment(attempt.assignmentId);
        if (['queued', 'running', 'waiting'].includes(assignment.state)) {
          this.store.assignments.upsert(
            AssignmentSchema.parse({
              ...assignment,
              state: 'waiting',
              updatedAt: now,
            }),
          );
        }

        let task = this.requireTask(attempt.taskId);
        if (['running', 'waiting_approval'].includes(task.state)) {
          task = TaskSchema.parse({ ...task, state: 'waiting', updatedAt: now });
          this.store.tasks.upsert(task);
        }
        this.appendEvent(task, 'attempt.interrupted', {
          assignmentId: assignment.id,
          attemptId: interrupted.id,
          reason: 'control_plane_restart',
        });
        recovered.push(interrupted);
      }
      return recovered;
    });
  }

  private createAttemptWithin(assignment: Assignment, input: CreateAttemptInput): ExecutionAttempt {
    const task = this.requireTask(assignment.taskId);
    if (terminalTaskStates.has(task.state)) {
      throw new TaskEngineError(
        'TASK_TERMINAL',
        `Cannot create an attempt for terminal task ${task.id}.`,
      );
    }

    const existingAttempts = this.store.executionAttempts
      .list()
      .filter((attempt) => attempt.assignmentId === assignment.id);
    const active = existingAttempts.find((attempt) =>
      ['queued', 'running', 'waiting'].includes(attempt.state),
    );
    if (active) {
      throw new TaskEngineError(
        'ATTEMPT_ACTIVE',
        `Assignment ${assignment.id} already has active attempt ${active.id}.`,
      );
    }

    const nextNumber =
      Math.max(assignment.attempt, ...existingAttempts.map((item) => item.number), 0) + 1;
    const now = this.now();
    const attempt = ExecutionAttemptSchema.parse({
      id: input.id ?? this.idFactory('attempt'),
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      number: nextNumber,
      state: 'queued',
      ...(input.runnerId === undefined ? {} : { runnerId: RunnerIdSchema.parse(input.runnerId) }),
      createdAt: now,
      updatedAt: now,
    });
    if (this.store.executionAttempts.get(attempt.id)) {
      throw new TaskEngineError('ATTEMPT_EXISTS', `Attempt already exists: ${attempt.id}`);
    }

    this.store.executionAttempts.upsert(attempt);
    this.store.assignments.upsert(
      AssignmentSchema.parse({
        ...assignment,
        attempt: nextNumber,
        state: 'queued',
        updatedAt: now,
      }),
    );
    this.appendEvent(task, 'attempt.created', {
      assignmentId: assignment.id,
      attemptId: attempt.id,
      attemptNumber: attempt.number,
    });
    return attempt;
  }

  private transitionTaskWithin(task: Task, nextState: TaskState): Task {
    if (task.state === nextState) {
      return task;
    }
    if (!allowedTransitions[task.state].has(nextState)) {
      throw new TaskEngineError(
        'INVALID_TASK_TRANSITION',
        `Invalid task transition: ${task.state} -> ${nextState}`,
      );
    }
    if (nextState === 'ready' || nextState === 'running') {
      this.assertDependenciesCompleted(task);
    }

    const updated = TaskSchema.parse({
      ...task,
      state: nextState,
      updatedAt: this.now(),
    });
    this.store.tasks.upsert(updated);
    this.appendEvent(updated, 'task.state_changed', {
      from: task.state,
      to: nextState,
    });
    return updated;
  }

  private validateParent(task: Task): void {
    if (!task.parentTaskId) {
      return;
    }
    if (task.parentTaskId === task.id) {
      throw new TaskEngineError('TASK_PARENT_SELF', 'A task cannot be its own parent.');
    }
    const parent = this.requireTask(task.parentTaskId);
    if (parent.projectId !== task.projectId) {
      throw new TaskEngineError('TASK_PROJECT_MISMATCH', 'Parent task belongs to another project.');
    }
  }

  private validateDependencies(
    taskId: Task['id'],
    projectId: Task['projectId'],
    dependencyIds: readonly Task['id'][],
  ): void {
    const unique = new Set<string>();
    for (const dependencyId of dependencyIds) {
      if (dependencyId === taskId) {
        throw new TaskEngineError('TASK_DEPENDENCY_SELF', 'A task cannot depend on itself.');
      }
      if (unique.has(dependencyId)) {
        throw new TaskEngineError(
          'TASK_DEPENDENCY_DUPLICATE',
          `Duplicate dependency: ${dependencyId}`,
        );
      }
      unique.add(dependencyId);
      const dependency = this.requireTask(dependencyId);
      if (dependency.projectId !== projectId) {
        throw new TaskEngineError(
          'TASK_PROJECT_MISMATCH',
          `Dependency ${dependencyId} belongs to another project.`,
        );
      }
      if (this.pathReaches(dependency.id, taskId, new Set())) {
        throw new TaskEngineError(
          'TASK_DEPENDENCY_CYCLE',
          'Task dependency graph must remain acyclic.',
        );
      }
    }
  }

  private pathReaches(currentId: Task['id'], targetId: Task['id'], visited: Set<string>): boolean {
    if (currentId === targetId) {
      return true;
    }
    if (visited.has(currentId)) {
      return false;
    }
    visited.add(currentId);
    const current = this.store.tasks.get(currentId);
    if (!current) {
      return false;
    }
    return current.dependencyIds.some((nextId) => this.pathReaches(nextId, targetId, visited));
  }

  private dependenciesCompleted(task: Task): boolean {
    return task.dependencyIds.every((dependencyId) => {
      const dependency = this.store.tasks.get(dependencyId);
      return dependency?.state === 'completed';
    });
  }

  private assertDependenciesCompleted(task: Task): void {
    if (!this.dependenciesCompleted(task)) {
      throw new TaskEngineError(
        'TASK_DEPENDENCIES_INCOMPLETE',
        `Task ${task.id} has incomplete dependencies.`,
      );
    }
  }

  private collectTaskSubtree(root: Task): Task[] {
    const result: Task[] = [];
    const visit = (task: Task) => {
      result.push(task);
      for (const child of this.store.tasks
        .list()
        .filter((candidate) => candidate.parentTaskId === task.id)) {
        visit(child);
      }
    };
    visit(root);
    return result;
  }

  private requireProject(projectId: string) {
    const parsed = ProjectIdSchema.parse(projectId);
    const project = this.store.projects.get(parsed);
    if (!project) {
      throw new TaskEngineError('PROJECT_NOT_FOUND', `Project not found: ${parsed}`);
    }
    return project;
  }

  private requireTask(taskId: Task['id']): Task {
    const task = this.store.tasks.get(taskId);
    if (!task) {
      throw new TaskEngineError('TASK_NOT_FOUND', `Task not found: ${taskId}`);
    }
    return task;
  }

  private requireAssignment(assignmentId: string): Assignment {
    const assignment = this.store.assignments.get(assignmentId);
    if (!assignment) {
      throw new TaskEngineError('ASSIGNMENT_NOT_FOUND', `Assignment not found: ${assignmentId}`);
    }
    return assignment;
  }

  private requireAttempt(attemptId: string): ExecutionAttempt {
    const attempt = this.store.executionAttempts.get(attemptId);
    if (!attempt) {
      throw new TaskEngineError('ATTEMPT_NOT_FOUND', `Attempt not found: ${attemptId}`);
    }
    return attempt;
  }

  private appendEvent(task: Task, type: string, payload: Record<string, unknown>): void {
    this.store.events.append(
      AuditEventSchema.parse({
        id: this.idFactory('event'),
        projectId: task.projectId,
        type,
        actor: { type: 'system', id: 'task-engine' },
        taskId: task.id,
        payload,
        occurredAt: this.now(),
      }),
    );
  }
}
