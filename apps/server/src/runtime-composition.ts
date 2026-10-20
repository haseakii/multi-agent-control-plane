import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as acp from '@agentclientprotocol/sdk';
import {
  AcpClientRuntime,
  CapabilitySelector,
  InMemoryAgentRegistry,
  ProcessAgentRuntimeControl,
  type AcpRuntimeConnection,
  type PermissionRequest,
} from '@control-plane/acp-runtime';
import {
  ArtifactStore,
  FilesystemArtifactBlobStore,
  SqliteArtifactMetadataStore,
} from '@control-plane/artifact-store';
import {
  AuditEventSchema,
  ProjectSchema,
  WorkspaceSchema,
  type AgentDefinition,
  type Approval,
  type Assignment,
  type ExecutionAttempt,
  type Task,
} from '@control-plane/core';
import {
  FleetBossSessionAttachment,
  FleetSessionAttachment,
  getFleetMcpStdioProxyPath,
  InMemoryFleetBridgeGrantStore,
  type FleetCallContext,
  type FleetControlServices,
} from '@control-plane/fleet-mcp';
import { MessageRouter, SqliteMessageRouterStore } from '@control-plane/message-router';
import {
  ApprovalService,
  PolicyEngine,
  PolicyRequestSchema,
  SqliteApprovalStore,
} from '@control-plane/policy';
import { LocalRunner, type ProcessHandle, type Runner } from '@control-plane/runner';
import type { SqliteStorage } from '@control-plane/storage';
import { TaskEngine } from '@control-plane/task-engine';
import { AgentControlService } from './agent-control.js';
import { createFleetGatewayOptions } from './fleet-composition.js';
import { CreateProjectSchema, SubmitGoalSchema, TaskControlError } from './task-control.js';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const id = (kind: string) => `${kind}-${randomUUID()}`;

export function requireCompletedAcpTurn(stopReason: string): void {
  if (stopReason !== 'end_turn') {
    throw new Error('ACP turn did not end successfully.');
  }
}

type ActiveExecution = {
  assignment: Assignment;
  attempt: ExecutionAttempt;
  abort: AbortController;
  completion: Promise<void>;
  waitingFor: Set<string>;
  handle?: ProcessHandle;
  connection?: AcpRuntimeConnection;
  sessionId?: string;
};

export type ControlPlaneRuntimeOptions = {
  storage: SqliteStorage;
  runner?: Runner;
  artifactRoot?: string;
  workspaceRoot?: string;
  executionTimeoutMs?: number;
};

/** Local V0 application composition. SQLite is durable; ACP sessions and grants are not task state. */
export class ControlPlaneRuntime {
  readonly agentControl: AgentControlService;
  readonly taskEngine: TaskEngine;
  readonly approvals: ApprovalService;
  readonly artifacts: ArtifactStore;
  readonly messages: MessageRouter;
  readonly fleetGateway;
  private readonly runner: Runner;
  private readonly grants: InMemoryFleetBridgeGrantStore;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly storage: SqliteStorage;
  private readonly workspaceRoot: string;
  private readonly executionTimeoutMs: number;
  private bridgeBaseUrl?: string;
  private closing = false;

  constructor(options: ControlPlaneRuntimeOptions) {
    this.storage = options.storage;
    this.runner = options.runner ?? new LocalRunner({ id: 'local' });
    this.workspaceRoot = resolve(options.workspaceRoot ?? '.data/workspaces');
    this.executionTimeoutMs = options.executionTimeoutMs ?? 30 * 60_000;
    this.grants = new InMemoryFleetBridgeGrantStore({ ttlMs: this.executionTimeoutMs + 60_000 });
    this.storage.repositories.runners.upsert(this.runner.descriptor());
    this.agentControl = new AgentControlService(
      this.storage,
      new ProcessAgentRuntimeControl(this.runner),
    );
    this.taskEngine = new TaskEngine(this.storage.repositories);
    this.approvals = new ApprovalService(new SqliteApprovalStore(this.storage), {
      now,
      idFactory: () => id('approval'),
    });
    this.artifacts = new ArtifactStore(
      new FilesystemArtifactBlobStore(resolve(options.artifactRoot ?? '.data/artifacts')),
      new SqliteArtifactMetadataStore(this.storage),
      { now, idFactory: id },
    );
    this.messages = new MessageRouter(new SqliteMessageRouterStore(this.storage), {
      now,
      idFactory: id,
      hooks: {
        authorize: async ({ sender, input }) => {
          const recipient = this.storage.repositories.agentDefinitions.get(input.toAgentId);
          const task = input.taskId ? this.storage.repositories.tasks.get(input.taskId) : undefined;
          return recipient?.enabled && (!input.taskId || task?.projectId === sender.projectId)
            ? { allowed: true }
            : { allowed: false, reason: 'Message recipient or project is unavailable.' };
        },
        audit: async (record) => {
          if ('delivery' in record)
            this.event(record.delivery.projectId, record.type, {
              messageId: record.delivery.messageId,
              deliveryId: record.delivery.id,
            });
        },
      },
    });
    this.fleetGateway = createFleetGatewayOptions({
      grants: this.grants,
      getAgent: (agentId) => this.storage.repositories.agentDefinitions.get(agentId),
      services: this.fleetServices(),
      auditDenied: async (record) => {
        if (record.identity)
          this.event(
            record.identity.projectId,
            'fleet.gateway.denied',
            {
              reason: record.reason,
              ...(record.toolName ? { toolName: record.toolName } : {}),
              enforcementMode: 'enforced',
              boundary: 'fleet-gateway',
            },
            record.identity.taskId,
          );
      },
      hooks: {
        authorize: async (request) => {
          const execution = request.identity.taskId
            ? this.active.get(request.identity.taskId)
            : undefined;
          if (
            !execution ||
            execution.assignment.agentId !== request.identity.agentId ||
            execution.sessionId !== request.identity.sessionId ||
            execution.abort.signal.aborted
          ) {
            return { allowed: false, reason: 'Session is not an active task execution.' };
          }
          const root = this.getTask(execution.assignment.taskId);
          if (root.projectId !== request.identity.projectId || terminal.has(root.state))
            return { allowed: false, reason: 'Task is not active in this project.' };
          const input = request.input as Record<string, unknown>;
          for (const key of ['taskId', 'parentTaskId']) {
            if (typeof input[key] === 'string' && !this.inTaskTree(input[key], root.id))
              return { allowed: false, reason: 'Task is outside this execution scope.' };
          }
          if (
            Array.isArray(input.dependencyIds) &&
            input.dependencyIds.some(
              (value) => typeof value !== 'string' || !this.inTaskTree(value, root.id),
            )
          )
            return { allowed: false, reason: 'Dependency is outside this execution scope.' };
          if (typeof input.artifactId === 'string' && !this.artifactInScope(input.artifactId, root))
            return { allowed: false, reason: 'Artifact is outside this execution scope.' };
          if (
            Array.isArray(input.artifactRefs) &&
            input.artifactRefs.some(
              (value) => typeof value !== 'string' || !this.artifactInScope(value, root),
            )
          )
            return { allowed: false, reason: 'Artifact is outside this execution scope.' };
          return { allowed: true };
        },
        audit: async (record) => {
          this.event(
            record.identity.projectId,
            'fleet.tool',
            {
              toolName: record.toolName,
              operation: record.operation,
              outcome: record.outcome,
              input: record.input,
              enforcementMode: 'enforced',
              boundary: 'fleet-gateway',
            },
            record.identity.taskId,
          );
        },
      },
    });
    this.taskEngine.recoverInterruptedAttempts();
    this.messages.recoverExpired();
    // A pending permission belongs to a live ACP call, not a replayable command.
    for (const approval of this.approvals.listPending())
      this.approvals.expire(approval.id, 'control-plane-restart');
  }

  setBridgeBaseUrl(baseUrl: string): void {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new TypeError('Bridge URL must use HTTP.');
    this.bridgeBaseUrl = url.href.replace(/\/$/, '');
  }

  createProject(input: unknown) {
    const parsed = CreateProjectSchema.parse(input);
    const project = ProjectSchema.parse({
      ...parsed,
      id: parsed.id ?? id('project'),
      createdAt: now(),
      updatedAt: now(),
    });
    if (this.storage.repositories.projects.get(project.id))
      throw new TaskControlError(409, 'Project already exists.');
    const rootPath = join(this.workspaceRoot, randomUUID());
    mkdirSync(rootPath, { recursive: true });
    this.storage.repositories.transaction(() => {
      this.storage.repositories.projects.upsert(project);
      this.storage.repositories.workspaces.upsert(
        WorkspaceSchema.parse({
          id: id('workspace'),
          projectId: project.id,
          runnerId: this.runner.descriptor().id,
          provider: 'local-directory',
          rootPath,
          access: 'read-write',
        }),
      );
      this.event(project.id, 'project.created', {
        enforcementMode: 'unavailable',
        boundary: 'local-runner',
        warning: 'LocalRunner and local directories are not OS security sandboxes.',
      });
    });
    return project;
  }

  getProject(projectId: string) {
    const project = this.storage.repositories.projects.get(projectId);
    if (!project) throw new TaskControlError(404, 'Project not found.');
    return project;
  }
  getTask(taskId: string): Task {
    const task = this.storage.repositories.tasks.get(taskId);
    if (!task) throw new TaskControlError(404, 'Task not found.');
    return task;
  }
  taskEvents(taskId: string) {
    const task = this.getTask(taskId);
    return this.storage.repositories.events
      .listByProject(task.projectId)
      .filter((event) => event.taskId === taskId);
  }
  taskMessages(taskId: string) {
    this.getTask(taskId);
    return this.storage.repositories.messages.list().filter((message) => message.taskId === taskId);
  }
  listApprovals(state?: Approval['state']) {
    return this.storage.repositories.approvals
      .list()
      .filter((approval) => !state || approval.state === state);
  }
  decideApproval(approvalId: string, state: 'approved' | 'rejected', actor: string) {
    const approval = this.storage.repositories.approvals.get(approvalId);
    if (!approval) throw new TaskControlError(404, 'Approval not found.');
    if (approval.state !== 'pending' && approval.state !== state)
      throw new TaskControlError(409, 'Approval is already decided or expired.');
    const result = this.approvals.resolve(approvalId, state, actor);
    this.event(
      result.projectId,
      'approval.decided',
      {
        approvalId,
        state,
        enforcementMode: result.enforcementMode,
        boundary: result.boundary ?? 'unknown',
      },
      result.taskId,
    );
    return result;
  }
  getArtifact(artifactId: string) {
    if (!this.storage.repositories.artifacts.get(artifactId))
      throw new TaskControlError(404, 'Artifact not found.');
    return this.artifacts.getMetadata(artifactId);
  }
  async loadArtifact(artifactId: string) {
    this.getArtifact(artifactId);
    return this.artifacts.load(artifactId);
  }

  submitGoal(projectId: string, input: unknown) {
    this.assertAvailable();
    const goal = SubmitGoalSchema.parse(input);
    const project = this.getProject(projectId);
    if (!project.defaultBossAgentId)
      throw new TaskControlError(409, 'Select a Boss before submitting a goal.');
    const agent = this.requireAgent(project.defaultBossAgentId);
    this.agentControl.selectBoss(project.id, agent.id);
    return this.storage.repositories.transaction(() => {
      const task = this.taskEngine.createTask({
        id: id('task'),
        projectId,
        title: goal.title ?? goal.objective.slice(0, 100),
        objective: goal.objective,
        state: 'ready',
      });
      const { assignment, attempt } = this.prepareExecution(task, agent, task.objective, {
        name: 'Boss',
      });
      this.launch(assignment, attempt, true);
      return { task, assignment, attempt };
    });
  }

  resumeTask(taskId: string) {
    this.assertAvailable();
    const task = this.getTask(taskId);
    if (this.active.has(taskId)) throw new TaskControlError(409, 'Task is already executing.');
    const assignment = this.storage.repositories.assignments
      .list()
      .filter((item) => item.taskId === taskId)
      .at(-1);
    if (!assignment) throw new TaskControlError(409, 'Task has no assignment to resume.');
    this.requireAgent(assignment.agentId);
    if (task.state === 'waiting_approval') this.taskEngine.transitionTask(task.id, 'ready');
    const attempt = this.taskEngine.retryAssignment(assignment.id, {
      runnerId: this.runner.descriptor().id,
    });
    this.launch(assignment, attempt, !task.parentTaskId, true);
    return {
      task: this.getTask(taskId),
      assignment: this.storage.repositories.assignments.get(assignment.id)!,
      attempt,
    };
  }

  async cancelTask(taskId: string) {
    const task = this.taskEngine.cancelTask(this.getTask(taskId).id);
    await Promise.all(
      [...this.active.entries()]
        .filter(([id]) => this.inTaskTree(id, taskId))
        .map(async ([, execution]) => {
          execution.abort.abort(new Error('Task cancelled.'));
          execution.connection?.close();
          if (execution.handle) await this.runner.stop(execution.handle).catch(() => undefined);
        }),
    );
    return task;
  }

  async close(): Promise<void> {
    this.closing = true;
    const executions = [...this.active.values()];
    for (const execution of executions) {
      execution.abort.abort(new Error('Server stopping.'));
      execution.connection?.close();
    }
    await Promise.all(
      executions.map(async (execution) => {
        if (execution.handle) await this.runner.stop(execution.handle).catch(() => undefined);
      }),
    );
    await Promise.all(executions.map((execution) => execution.completion));
    this.taskEngine.recoverInterruptedAttempts();
  }

  private assertAvailable() {
    if (this.closing || !this.bridgeBaseUrl)
      throw new TaskControlError(503, 'Execution gateway is not ready.');
    this.assertCapacity();
  }
  private assertCapacity() {
    const unfinished = this.storage.repositories.executionAttempts
      .list()
      .filter((attempt) => ['queued', 'running', 'waiting'].includes(attempt.state)).length;
    if (Math.max(this.active.size, unfinished) >= 16) {
      throw new TaskControlError(409, 'V0 concurrent execution limit reached.');
    }
  }
  private requireAgent(agentId: string) {
    const agent = this.storage.repositories.agentDefinitions.get(agentId);
    if (!agent?.enabled) throw new TaskControlError(400, 'Agent is missing or disabled.');
    return agent;
  }
  private inTaskTree(taskId: string, rootId: string): boolean {
    let task = this.storage.repositories.tasks.get(taskId);
    const visited = new Set<string>();
    while (task && !visited.has(task.id)) {
      if (task.id === rootId) return true;
      visited.add(task.id);
      task = task.parentTaskId ? this.storage.repositories.tasks.get(task.parentTaskId) : undefined;
    }
    return false;
  }
  private executionDependsOn(taskId: string, targetId: string, seen = new Set<string>()): boolean {
    if (taskId === targetId || this.inTaskTree(targetId, taskId)) return true;
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    const execution = this.active.get(taskId);
    return [...(execution?.waitingFor ?? [])].some((dependency) =>
      this.executionDependsOn(dependency, targetId, seen),
    );
  }
  private artifactInScope(artifactId: string, task: Task) {
    const artifact = this.storage.repositories.artifacts.get(artifactId);
    return (
      artifact?.projectId === task.projectId &&
      (Boolean(artifact.taskId && this.inTaskTree(artifact.taskId, task.id)) ||
        this.storage.repositories.messages
          .list()
          .some(
            (message) =>
              message.projectId === task.projectId &&
              message.artifactRefs.includes(artifact.id) &&
              (message.metadata.recipientTaskId === task.id ||
                message.metadata.parentTaskId === task.id),
          ))
    );
  }
  private event(
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
    taskId?: string,
  ) {
    this.storage.repositories.events.append(
      AuditEventSchema.parse({
        id: id('event'),
        projectId,
        taskId,
        type,
        actor: { type: 'system', id: 'runtime-composition' },
        payload,
        occurredAt: now(),
      }),
    );
  }
  private prepareExecution(
    task: Task,
    agent: AgentDefinition,
    objective: string,
    role?: { name: string; description?: string | undefined },
  ) {
    this.assertCapacity();
    if (
      task.state !== 'ready' ||
      this.active.has(task.id) ||
      this.storage.repositories.executionAttempts
        .list()
        .some(
          (attempt) =>
            attempt.taskId === task.id && ['queued', 'running', 'waiting'].includes(attempt.state),
        )
    )
      throw new TaskControlError(409, 'Task already has an execution or is not ready.');
    const assignment = this.taskEngine.createAssignment({
      id: id('assignment'),
      taskId: task.id,
      agentId: agent.id,
      objective,
      ...(role
        ? {
            role: {
              name: role.name,
              ...(role.description === undefined ? {} : { description: role.description }),
            },
          }
        : {}),
    });
    const attempt = this.taskEngine.createAttempt(assignment.id, {
      runnerId: this.runner.descriptor().id,
    });
    return {
      assignment: this.storage.repositories.assignments.get(assignment.id)!,
      attempt,
    };
  }

  private launch(assignment: Assignment, attempt: ExecutionAttempt, boss: boolean, resume = false) {
    // In-flight services may enqueue during shutdown. Keep those attempts durable
    // and unstarted; close() will recover them as interrupted.
    if (this.closing) return;
    const execution: ActiveExecution = {
      assignment,
      attempt,
      abort: new AbortController(),
      completion: Promise.resolve(),
      waitingFor: new Set(
        this.storage.repositories.messages
          .list()
          .filter(
            (message) =>
              message.type === 'request' && message.metadata.senderTaskId === assignment.taskId,
          )
          .flatMap((message) =>
            typeof message.metadata.recipientTaskId === 'string'
              ? [message.metadata.recipientTaskId]
              : [],
          ),
      ),
    };
    this.active.set(assignment.taskId, execution);
    // Queue after the transaction and the 202 response have a chance to commit.
    execution.completion = Promise.resolve()
      .then(() => this.execute(execution, boss, resume))
      .finally(() => this.active.delete(assignment.taskId));
  }

  private async execute(execution: ActiveExecution, boss: boolean, resume: boolean): Promise<void> {
    const { assignment, attempt } = execution;
    let task = this.getTask(assignment.taskId);
    let grantToken: string | undefined;
    let stage = 'starting';
    try {
      this.taskEngine.startAttempt(attempt.id);
      const agent = this.requireAgent(assignment.agentId);
      const workspace = this.storage.repositories.workspaces
        .list()
        .find((item) => item.projectId === task.projectId);
      if (!workspace) throw new Error('Project has no local workspace.');
      const environment = Object.fromEntries(
        (agent.runtime.environmentAllowlist ?? []).flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]!]],
        ),
      );
      stage = 'process_spawn';
      const handle = await this.runner.spawn({
        command: agent.runtime.command,
        args: agent.runtime.args,
        cwd: agent.runtime.cwd ?? workspace.rootPath,
        env: environment,
        timeoutMs: this.executionTimeoutMs,
        signal: execution.abort.signal,
      });
      execution.handle = handle;
      const transport = this.runner.transport(handle);
      stage = 'acp_initialize';
      const connection = await new AcpClientRuntime({
        permissionBroker: { decide: (request) => this.permission(execution, request) },
      }).connect(acp.ndJsonStream(transport.writable, transport.readable));
      execution.connection = connection;
      const previous = resume
        ? this.storage.repositories.conversations
            .list()
            .filter((item) => item.assignmentId === assignment.id)
            .at(-1)
        : undefined;
      stage = 'session_attachment';
      let session: { sessionId: string };
      const scopes = agent.controlBridge.scopes.filter(
        (scope) => boss || scope !== 'boss.orchestration',
      );
      if (boss || (agent.controlBridge.transport === 'mcp' && scopes.length > 0)) {
        const Attachment = boss ? FleetBossSessionAttachment : FleetSessionAttachment;
        const attachment = new Attachment(
          {
            newSession: (input) =>
              connection.newSession({ cwd: input.cwd, mcpServers: input.mcpServers ?? [] }),
            resumeSession: (sessionId, input) =>
              connection.resumeSession(sessionId, {
                cwd: input.cwd,
                mcpServers: input.mcpServers ?? [],
              }),
          },
          {
            issue: async (request) => {
              const grant = await this.grants.issue(request);
              grantToken = grant.token;
              return grant;
            },
            bindSession: (token, sessionId) => this.grants.bindSession(token, sessionId),
            revoke: (token) => this.grants.revoke(token),
          },
          {
            command: process.execPath,
            args: [getFleetMcpStdioProxyPath()],
            environment: { CONTROL_PLANE_BRIDGE_URL: this.bridgeBaseUrl! },
          },
        );
        const context = {
          agent,
          projectId: task.projectId,
          taskId: task.id,
          scopes,
          cwd: workspace.rootPath,
        };
        session = (
          previous && connection.capabilities.loadSession
            ? await attachment.resume(previous.sessionId, context)
            : await attachment.create(context)
        ).session;
      } else {
        session =
          previous && connection.capabilities.loadSession
            ? await connection.resumeSession(previous.sessionId, { cwd: workspace.rootPath })
            : await connection.newSession({ cwd: workspace.rootPath });
      }
      execution.sessionId = session.sessionId;
      this.taskEngine.attachConversation({
        id: id('conversation'),
        executionAttemptId: attempt.id,
        runnerId: this.runner.descriptor().id,
        protocol: 'acp',
        sessionId: session.sessionId,
      });
      this.event(
        task.projectId,
        'execution.boundary',
        {
          enforcementMode: 'unavailable',
          boundary: 'local-runner',
          warning:
            'Agent-owned tools are not intercepted. ACP permission requests are cooperative.',
        },
        task.id,
      );
      stage = 'agent_prompt';
      const initialDeliveries = await this.claimMailbox(task.id, agent.id);
      const initialPrompt = resume
        ? `Resume the durable task. Inspect completed subtasks before repeating work.\n${assignment.objective}`
        : assignment.objective;
      // ACP response completion is not the durable result commit. After a crash or
      // publication failure, replay acknowledged inputs even if loadSession is unavailable.
      const deliveredContext = resume ? this.deliveredMailbox(task.id, agent.id) : [];
      let output = await this.prompt(
        execution,
        initialPrompt +
          (deliveredContext.length
            ? `\nPreviously delivered messages (recovery context, not new work):\n${JSON.stringify(deliveredContext)}`
            : '') +
          (initialDeliveries.length
            ? `\nRouted messages:\n${JSON.stringify(initialDeliveries.map(({ message }) => message))}`
            : ''),
      );
      for (const delivery of initialDeliveries)
        await this.messages.acknowledge(delivery.delivery.id, delivery.delivery.attemptCount);
      {
        let round = 0;
        for (;;) {
          if (execution.abort.signal.aborted) throw execution.abort.signal.reason;
          const children = [...this.active.values()].filter(
            (child) =>
              child !== execution &&
              (this.inTaskTree(child.assignment.taskId, task.id) ||
                execution.waitingFor.has(child.assignment.taskId)),
          );
          if (children.length) {
            this.taskEngine.transitionTask(task.id, 'waiting');
            await Promise.all(children.map((child) => child.completion));
            if (execution.abort.signal.aborted) throw execution.abort.signal.reason;
            this.taskEngine.transitionTask(task.id, 'running');
          }
          // Repair a crash between task completion and its outbox notification.
          for (const child of this.taskEngine.listChildren(task.id)) {
            if (!terminal.has(child.state)) continue;
            const producer = this.storage.repositories.assignments
              .list()
              .filter((item) => item.taskId === child.id)
              .at(-1);
            if (producer) await this.notifyParent(child, producer.agentId);
          }
          this.messages.recoverExpired();
          const mailboxKey = `task:${task.id}:agent:${agent.id}`;
          const deliveries = [];
          for (;;) {
            const delivery = await this.messages.claimNext(agent.id, {
              mailboxKey,
            });
            if (!delivery) break;
            deliveries.push(delivery);
          }
          if (!deliveries.length) {
            const outstanding = this.storage.sqlite
              .prepare(
                "SELECT COUNT(*) AS count FROM message_deliveries WHERE mailbox_key = ? AND state IN ('pending', 'delivering')",
              )
              .get(mailboxKey) as { count: number };
            if (!outstanding.count) break;
            // A claim held by the previous process is not a delivered result.
            await delay(100, undefined, { signal: execution.abort.signal });
            continue;
          }
          if (++round > 32) throw new Error('Boss exceeded the V0 continuation limit.');
          output = await this.prompt(
            execution,
            `Continue with durable worker results. Use artifact references to retrieve details and finish the goal when ready.\n${JSON.stringify(deliveries.map(({ message }) => message))}`,
          );
          for (const delivery of deliveries)
            await this.messages.acknowledge(delivery.delivery.id, delivery.delivery.attemptCount);
        }
      }
      if (execution.abort.signal.aborted) throw execution.abort.signal.reason;
      if (
        this.taskEngine.listChildren(task.id).some((child) => !terminal.has(child.state)) ||
        [...execution.waitingFor].some(
          (dependency) => !terminal.has(this.getTask(dependency).state),
        )
      ) {
        throw new Error(
          'Interrupted or unassigned subtasks must be resolved before completing the goal.',
        );
      }
      stage = 'artifact_publish';
      const published = await this.artifacts.publish({
        projectId: task.projectId,
        taskId: task.id,
        assignmentId: assignment.id,
        producerAgentId: agent.id,
        kind: 'report',
        mimeType: 'text/plain',
        content: new TextEncoder().encode(output),
        links: [
          { entityType: 'task', entityId: task.id },
          { entityType: 'assignment', entityId: assignment.id },
        ],
      });
      // Never strand a completed attempt beside a waiting task with no result refs.
      task = this.storage.repositories.transaction(() => {
        this.taskEngine.finishAttempt(attempt.id, { outcome: 'completed' });
        return this.taskEngine.completeTask(task.id, [published.artifact.id]);
      });
      await this.notifyParent(task, agent.id);
    } catch {
      // Never persist arbitrary exception strings: transport failures may include credentials.
      const current = this.storage.repositories.executionAttempts.get(attempt.id);
      if (!this.closing && current && ['running', 'waiting'].includes(current.state)) {
        this.event(
          task.projectId,
          'execution.failed',
          { stage, code: 'EXECUTION_FAILED' },
          task.id,
        );
        this.taskEngine.finishAttempt(attempt.id, {
          outcome: 'failed',
          failure: {
            code: 'EXECUTION_FAILED',
            message:
              'Agent execution failed. Inspect runtime and authorization readiness before retrying.',
            retryable: true,
          },
        });
        await this.notifyParent(this.getTask(task.id), assignment.agentId).catch(() => undefined);
      }
    } finally {
      if (grantToken) await this.grants.revoke(grantToken);
      execution.connection?.close();
      if (execution.handle) await this.runner.stop(execution.handle).catch(() => undefined);
      for (const approval of this.approvals
        .listPending(task.projectId)
        .filter((item) => item.assignmentId === assignment.id))
        this.approvals.expire(approval.id, 'execution-ended');
    }
  }

  private async claimMailbox(taskId: string, agentId: string) {
    const deliveries = [];
    for (;;) {
      const delivery = await this.messages.claimNext(agentId, {
        mailboxKey: `task:${taskId}:agent:${agentId}`,
      });
      if (!delivery) return deliveries;
      deliveries.push(delivery);
    }
  }

  private deliveredMailbox(taskId: string, agentId: string) {
    const rows = this.storage.sqlite
      .prepare(
        "SELECT message_id FROM message_deliveries WHERE mailbox_key = ? AND state = 'delivered' ORDER BY sequence",
      )
      .all(`task:${taskId}:agent:${agentId}`) as Array<{ message_id: string }>;
    return rows.map((row) => this.messages.getMessage(row.message_id));
  }

  private async prompt(execution: ActiveExecution, text: string): Promise<string> {
    let output = '';
    for await (const event of execution.connection!.prompt(execution.sessionId!, text)) {
      if (event.type === 'text_delta') {
        output += event.text;
        if (Buffer.byteLength(output) > 10 * 1024 * 1024)
          throw new Error('Agent output exceeds the V0 artifact limit.');
      }
      if (event.type === 'completed') requireCompletedAcpTurn(event.stopReason);
      if (execution.abort.signal.aborted) throw execution.abort.signal.reason;
    }
    return output;
  }

  private async permission(execution: ActiveExecution, request: PermissionRequest) {
    const option = request.options.find((item) => item.kind === 'allow_once');
    if (!option) return { outcome: 'cancelled' as const };
    const subject =
      request.subject && typeof request.subject === 'object'
        ? (request.subject as Record<string, unknown>)
        : {};
    const approval = await this.requestApproval(
      execution,
      'acp.tool',
      {
        sessionId: request.sessionId,
        title: typeof subject.title === 'string' ? subject.title : 'Agent tool operation',
        kind: typeof subject.kind === 'string' ? subject.kind : 'unknown',
        options: request.options.map(({ optionId, name, kind }) => ({
          optionId,
          name,
          ...(kind ? { kind } : {}),
        })),
        notice:
          'The agent requests permission for an opaque tool operation. LocalRunner does not enforce its side effects.',
      },
      'cooperative',
      'acp-permission',
    );
    return approval.state === 'approved'
      ? { outcome: 'selected' as const, optionId: option.optionId }
      : { outcome: 'cancelled' as const };
  }

  private async requestApproval(
    execution: ActiveExecution,
    action: string,
    resource: unknown,
    enforcementMode: 'cooperative' | 'enforced',
    boundary: string,
  ) {
    const task = this.getTask(execution.assignment.taskId);
    const request = PolicyRequestSchema.parse({
      projectId: task.projectId,
      taskId: task.id,
      assignmentId: execution.assignment.id,
      requesterAgentId: execution.assignment.agentId,
      action,
      resource,
      enforcementMode,
      boundary,
    });
    const decision = new PolicyEngine({
      rules: [{ id: 'explicit-runtime-approval', actionPattern: '*', effect: 'ask' }],
    }).evaluate(request);
    const approval = this.approvals.request(request, decision);
    this.taskEngine.transitionTask(task.id, 'waiting_approval');
    this.event(
      task.projectId,
      'approval.requested',
      { approvalId: approval.id, action, enforcementMode, boundary },
      task.id,
    );
    try {
      return await this.approvals.waitForDecision(approval.id, { signal: execution.abort.signal });
    } finally {
      if (this.getTask(task.id).state === 'waiting_approval' && !execution.abort.signal.aborted)
        this.taskEngine.transitionTask(task.id, 'running');
    }
  }

  private async notifyParent(task: Task, agentId: AgentDefinition['id']) {
    if (!task.parentTaskId) return;
    const parentAssignment = this.storage.repositories.assignments
      .list()
      .filter((item) => item.taskId === task.parentTaskId)
      .at(-1);
    if (!parentAssignment) return;
    await this.messages.send(
      { projectId: task.projectId, agentId },
      {
        toAgentId: parentAssignment.agentId,
        taskId: task.id,
        mailboxKey: `task:${task.parentTaskId}:agent:${parentAssignment.agentId}`,
        type: 'response',
        content: `Worker task ${task.id} ${task.state}.`,
        artifactRefs: task.resultArtifactRefs,
        metadata: { parentTaskId: task.parentTaskId },
        idempotencyKey: `task-result:${task.id}:${task.updatedAt}`,
      },
    );
  }

  private fleetServices(): FleetControlServices {
    const executionFor = (context: FleetCallContext) => {
      const execution = context.identity.taskId
        ? this.active.get(context.identity.taskId)
        : undefined;
      if (!execution) throw new Error('No active execution.');
      return execution;
    };
    return {
      discoverAgents: async (input) => {
        const registry = new InMemoryAgentRegistry();
        for (const agent of this.storage.repositories.agentDefinitions.list())
          registry.create(agent);
        const selector = new CapabilitySelector(registry, {
          getReadiness: (agentId) => this.agentControl.state(agentId).readiness,
          policyAllows: () => true,
          customCapabilityMatcher: (capability, query) => capability.name.includes(query),
        });
        return selector.select(input).map(({ agent, matchedCapabilities, score }) => ({
          agentId: agent.id,
          name: agent.name,
          matchedCapabilities: matchedCapabilities.map((item) => item.name),
          score,
        }));
      },
      getAgent: async ({ agentId }) => this.requireAgent(agentId),
      createTask: async (input, context) =>
        this.taskEngine.createTask({
          id: id('task'),
          projectId: context.identity.projectId,
          ...((input.parentTaskId ?? context.identity.taskId)
            ? { parentTaskId: (input.parentTaskId ?? context.identity.taskId)! }
            : {}),
          title: input.title,
          objective: input.objective,
          state: 'ready',
          dependencyIds: input.dependencyIds ?? [],
          contextRefs: input.contextRefs ?? [],
        }),
      delegateTask: async (input) => {
        this.assertCapacity();
        const task = this.getTask(input.taskId);
        const agent = this.requireAgent(input.agentId);
        const prepared = this.prepareExecution(
          task,
          agent,
          input.objective ?? task.objective,
          input.role,
        );
        this.launch(prepared.assignment, prepared.attempt, false);
        return prepared;
      },
      getTask: async ({ taskId }) => this.getTask(taskId),
      waitTask: async ({ taskId, timeoutMs = 30_000 }) => {
        const execution = this.active.get(taskId);
        if (execution) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              execution.completion,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        return this.getTask(taskId);
      },
      sendMessage: async (input, context) => {
        if (Buffer.byteLength(input.content ?? '') > 64_000)
          throw new TaskControlError(400, 'Publish large message content as an artifact.');
        const senderTask = this.getTask(context.identity.taskId!);
        const recipient = this.requireAgent(input.targetAgentId);
        const recipients = [...this.active.values()].filter(
          (execution) =>
            execution.assignment.agentId === recipient.id &&
            this.getTask(execution.assignment.taskId).projectId === senderTask.projectId,
        );
        if (recipients.length > 1)
          throw new TaskControlError(
            409,
            'Recipient has multiple active tasks; message destination is ambiguous.',
          );
        let recipientTaskId = recipients[0]?.assignment.taskId;
        let prepared: ReturnType<ControlPlaneRuntime['prepareExecution']> | undefined;
        if (!recipientTaskId) {
          this.assertCapacity();
          const task = this.taskEngine.createTask({
            id: id('task'),
            projectId: senderTask.projectId,
            parentTaskId: senderTask.id,
            title: `Message for ${recipient.name}`,
            objective:
              'Respond to the routed message. If a reply is needed and agent.messaging is granted, send it to the message sender using control_send_message. Do not invent Boss privileges.',
            state: 'ready',
          });
          recipientTaskId = task.id;
          prepared = this.prepareExecution(task, recipient, task.objective);
        }
        const senderExecution = executionFor(context);
        const waiting = input.type === 'request' && recipientTaskId !== senderTask.id;
        if (waiting && this.executionDependsOn(recipientTaskId, senderTask.id)) {
          throw new TaskControlError(
            409,
            'Cyclic synchronous message requests are not supported; send a response instead.',
          );
        }
        if (waiting) senderExecution.waitingFor.add(recipientTaskId);
        try {
          const result = await this.messages.send(
            { projectId: senderTask.projectId, agentId: context.identity.agentId },
            {
              toAgentId: recipient.id,
              taskId: input.taskId ?? senderTask.id,
              mailboxKey: `task:${recipientTaskId}:agent:${recipient.id}`,
              type: input.type,
              content: input.content,
              artifactRefs: input.artifactRefs ?? [],
              metadata: { recipientTaskId, senderTaskId: senderTask.id },
            },
          );
          if (prepared) this.launch(prepared.assignment, prepared.attempt, false);
          return result;
        } catch (error) {
          if (waiting) senderExecution.waitingFor.delete(recipientTaskId);
          if (prepared) this.taskEngine.cancelTask(recipientTaskId);
          throw error;
        }
      },
      publishArtifact: async (input, context) =>
        (
          await this.artifacts.publish({
            projectId: this.getProject(context.identity.projectId).id,
            taskId: input.taskId ?? context.identity.taskId,
            producerAgentId: context.identity.agentId,
            kind: input.kind,
            mimeType: input.mimeType,
            content: new TextEncoder().encode(input.content),
            links: [{ entityType: 'task', entityId: input.taskId ?? context.identity.taskId! }],
          })
        ).artifact,
      getArtifact: async ({ artifactId }) => {
        const loaded = await this.loadArtifact(artifactId);
        return {
          ...loaded.artifact,
          ...(loaded.artifact.sizeBytes <= 64_000 && loaded.artifact.mimeType.startsWith('text/')
            ? { content: new TextDecoder().decode(loaded.content) }
            : {}),
          contentUrl: `/api/artifacts/${artifactId}/content`,
        };
      },
      requestApproval: async (input, context) =>
        this.requestApproval(
          executionFor(context),
          input.action,
          input.resource,
          'cooperative',
          'agent-request',
        ),
      cancelTask: async ({ taskId }) => this.cancelTask(taskId),
    };
  }
}

export function createControlPlaneRuntime(options: ControlPlaneRuntimeOptions) {
  return new ControlPlaneRuntime(options);
}
