import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import {
  AcpClientRuntime,
  CapabilitySelector,
  InMemoryAgentRegistry,
  type AcpRuntimeConnection,
} from '@control-plane/acp-runtime';
import {
  ArtifactStore,
  FilesystemArtifactBlobStore,
  SqliteArtifactMetadataStore,
} from '@control-plane/artifact-store';
import {
  AgentDefinitionSchema,
  AgentIdSchema,
  ProjectIdSchema,
  ProjectSchema,
  type AgentDefinition,
} from '@control-plane/core';
import {
  FleetBossSessionAttachment,
  InMemoryFleetBridgeGrantStore,
  type FleetAuditRecord,
  type FleetControlServices,
} from '@control-plane/fleet-mcp';
import { MessageRouter, SqliteMessageRouterStore } from '@control-plane/message-router';
import { LocalRunner, type ProcessHandle } from '@control-plane/runner';
import { openSqliteStorage } from '@control-plane/storage';
import { TaskEngine } from '@control-plane/task-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createFleetGatewayOptions } from './fleet-composition.js';
import { buildServer } from './server.js';

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

async function promptText(
  connection: AcpRuntimeConnection,
  sessionId: string,
  prompt: string,
): Promise<string> {
  let text = '';
  for await (const event of connection.prompt(sessionId, prompt)) {
    if (event.type === 'text_delta') {
      text += event.text;
    }
  }
  return text;
}

describe('V0 real-process acceptance path', () => {
  it('runs ACP Boss and worker through LocalRunner, then resumes a pending durable result after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'control-plane-v0-process-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'control-plane.sqlite');
    const blobRoot = join(directory, 'artifacts');
    const projectId = ProjectIdSchema.parse('process-project');
    const now = () => new Date().toISOString();
    let sequence = 0;
    const idFactory = (kind: string) => `${kind}-process-${++sequence}`;
    const audit: FleetAuditRecord[] = [];
    const runner = new LocalRunner({ id: 'local', defaultStopGracePeriodMs: 250 });
    const bossDefinition = AgentDefinitionSchema.parse({
      id: 'boss-agent',
      name: 'Process Boss',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/boss-agent.mjs', import.meta.url))],
      },
      capabilities: [{ name: 'planning', source: 'verified' }],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: {
        transport: 'mcp',
        scopes: ['boss.orchestration', 'artifact.read', 'artifact.publish'],
      },
    });
    const workerDefinition = AgentDefinitionSchema.parse({
      id: 'worker-agent',
      name: 'Process Worker',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/worker-agent.mjs', import.meta.url))],
      },
      capabilities: [{ name: 'code.review', source: 'verified' }],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });

    async function startAgent(definition: AgentDefinition) {
      const handle = await runner.spawn({
        command: definition.runtime.command,
        args: [...definition.runtime.args],
        cwd: directory,
        timeoutMs: 20_000,
      });
      let connection: AcpRuntimeConnection | undefined;
      let stopped = false;
      const stop = async () => {
        if (!stopped) {
          stopped = true;
          connection?.close();
          await runner.stop(handle);
        }
      };
      cleanup.push(stop);
      const transport = runner.transport(handle);
      connection = await new AcpClientRuntime().connect(
        acp.ndJsonStream(transport.writable, transport.readable),
      );
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.pid).not.toBe(process.pid);
      expect(connection.readiness).toMatchObject({
        runtime: 'ready',
        auth: 'not_reported',
      });
      return { handle, connection, stop };
    }

    // Only the composition is supplied by the harness. The transports, ACP/MCP
    // runtimes, gateway, repositories, task engine and artifact store are real.
    function openControlPlane() {
      const storage = openSqliteStorage({ filename });
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          storage.close();
        }
      };
      cleanup.push(close);
      const registry = new InMemoryAgentRegistry();
      for (const definition of storage.repositories.agentDefinitions.list()) {
        registry.create(definition);
      }
      const selector = new CapabilitySelector(registry, {
        getReadiness: () => ({
          runtime: 'ready',
          auth: 'not_reported',
          observedAt: now(),
          authMethodIds: [],
        }),
        policyAllows: () => true,
      });
      const tasks = new TaskEngine(storage.repositories, { now, idFactory });
      const messages = new SqliteMessageRouterStore(storage);
      const router = new MessageRouter(messages, {
        now,
        idFactory,
        hooks: {
          authorize: async () => ({ allowed: true }),
          audit: async () => undefined,
        },
      });
      const artifacts = new ArtifactStore(
        new FilesystemArtifactBlobStore(blobRoot),
        new SqliteArtifactMetadataStore(storage),
        { now, idFactory },
      );
      const services: FleetControlServices = {
        discoverAgents: async (input) =>
          selector.select(input).map((selection) => ({
            agentId: selection.agent.id,
            matchedCapabilities: selection.matchedCapabilities.map((item) => item.name),
            score: selection.score,
          })),
        getAgent: async ({ agentId }) => registry.get(AgentIdSchema.parse(agentId)),
        createTask: async (input, context) =>
          tasks.createTask({
            id: 'worker-task',
            projectId: context.identity.projectId,
            ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
            title: input.title,
            objective: input.objective,
            state: 'ready',
          }),
        delegateTask: async (input) => {
          const assignment = tasks.createAssignment({
            id: 'worker-assignment',
            taskId: input.taskId,
            agentId: input.agentId,
            objective: input.objective ?? tasks.getTask(input.taskId).objective,
            ...(input.role
              ? {
                  role: {
                    name: input.role.name,
                    ...(input.role.description === undefined
                      ? {}
                      : { description: input.role.description }),
                  },
                }
              : {}),
          });
          const attempt = tasks.createAttempt(assignment.id, {
            id: 'worker-attempt',
            runnerId: 'local',
          });
          return { assignment, attempt };
        },
        getTask: async ({ taskId }) => tasks.getTask(taskId),
        waitTask: async ({ taskId }) => tasks.getTask(taskId),
        getArtifact: async ({ artifactId }) => artifacts.getMetadata(artifactId),
        cancelTask: async ({ taskId }) => tasks.cancelTask(taskId),
        // Not part of this grant or acceptance workflow. Fail if unexpectedly called.
        sendMessage: async () => {
          throw new Error('Boss must not send messages in this acceptance scenario.');
        },
        publishArtifact: async () => {
          throw new Error('Boss must not publish artifacts with its reduced grant.');
        },
        requestApproval: async () => {
          throw new Error('This scenario must not require an approval.');
        },
      };
      return { storage, registry, tasks, messages, router, artifacts, services, close };
    }

    async function startGateway(control: ReturnType<typeof openControlPlane>) {
      const grants = new InMemoryFleetBridgeGrantStore();
      const app = buildServer({
        fleetGateway: createFleetGatewayOptions({
          grants,
          getAgent: (id) => control.registry.get(id),
          services: control.services,
          hooks: {
            authorize: async () => ({ allowed: true }),
            audit: async (record) => {
              audit.push(record);
            },
          },
        }),
      });
      cleanup.push(() => app.close());
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const attach = (connection: AcpRuntimeConnection) =>
        new FleetBossSessionAttachment(
          {
            newSession: (input) =>
              connection.newSession({
                cwd: input.cwd,
                mcpServers: input.mcpServers ?? [],
              }),
            resumeSession: (sessionId, input) =>
              connection.resumeSession(sessionId, {
                cwd: input.cwd,
                mcpServers: input.mcpServers ?? [],
              }),
          },
          grants,
          {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL('../../../packages/fleet-mcp/dist/stdio-proxy-main.js', import.meta.url),
              ),
            ],
            environment: { CONTROL_PLANE_BRIDGE_URL: address },
          },
        );
      return { app, attach };
    }

    const first = openControlPlane();
    first.storage.repositories.projects.upsert(
      ProjectSchema.parse({
        id: projectId,
        name: 'V0 process acceptance',
        defaultBossAgentId: bossDefinition.id,
        createdAt: now(),
        updatedAt: now(),
      }),
    );
    first.storage.repositories.runners.upsert(runner.descriptor());
    for (const definition of [bossDefinition, workerDefinition]) {
      first.storage.repositories.agentDefinitions.upsert(definition);
      first.registry.create(definition);
    }
    first.tasks.createTask({
      id: 'root-task',
      projectId,
      title: 'Complete V0 goal',
      objective: 'Delegate a review and incorporate the result.',
      state: 'ready',
    });
    const gateway = await startGateway(first);
    const boss = await startAgent(bossDefinition);
    const bossContext = {
      agent: bossDefinition,
      projectId,
      taskId: 'root-task',
      scopes: ['boss.orchestration', 'artifact.read'] as const,
      cwd: directory,
    };
    const attached = await gateway.attach(boss.connection).create({
      ...bossContext,
      scopes: [...bossContext.scopes],
    });
    const delegated = JSON.parse(
      await promptText(
        boss.connection,
        attached.session.sessionId,
        JSON.stringify({ action: 'delegate', rootTaskId: 'root-task' }),
      ),
    );
    expect(delegated).toEqual({
      delegatedTaskId: 'worker-task',
      workerAgentId: 'worker-agent',
    });
    expect(first.tasks.getTask('worker-task').parentTaskId).toBe('root-task');
    expect(first.storage.repositories.assignments.get('worker-assignment')?.role?.name).toBe(
      'boundary reviewer',
    );

    const worker = await startAgent(workerDefinition);
    expect(worker.handle.pid).not.toBe(boss.handle.pid);
    const workerSession = await worker.connection.newSession({ cwd: directory });
    first.tasks.startAttempt('worker-attempt');
    first.tasks.attachConversation({
      id: 'worker-conversation',
      executionAttemptId: 'worker-attempt',
      runnerId: 'local',
      protocol: 'acp',
      sessionId: workerSession.sessionId,
    });
    const workerResult = await promptText(
      worker.connection,
      workerSession.sessionId,
      first.tasks.getTask('worker-task').objective,
    );
    expect(workerResult).toBe('Worker review: boundaries are consistent. 验收通过 ✓');
    const published = await first.artifacts.publish({
      projectId,
      taskId: 'worker-task',
      assignmentId: 'worker-assignment',
      producerAgentId: workerDefinition.id,
      kind: 'report',
      mimeType: 'text/plain',
      content: new TextEncoder().encode(workerResult),
      links: [
        { entityType: 'task', entityId: 'worker-task' },
        { entityType: 'assignment', entityId: 'worker-assignment' },
      ],
    });
    first.tasks.finishAttempt('worker-attempt', { outcome: 'completed' });
    first.tasks.completeTask('worker-task', [published.artifact.id]);
    const queued = await first.router.send(
      { projectId, agentId: workerDefinition.id },
      {
        toAgentId: bossDefinition.id,
        taskId: 'worker-task',
        type: 'response',
        content: workerResult,
        artifactRefs: [published.artifact.id],
        idempotencyKey: 'worker-result',
      },
    );
    expect(first.messages.getDelivery(queued.delivery.id)?.state).toBe('pending');
    expect(first.tasks.getTask('root-task').state).toBe('ready');

    // Stop both actual ACP processes and their MCP children before reopening
    // SQLite, the HTTP gateway, and the Boss with a fresh session-bound grant.
    await worker.stop();
    await boss.stop();
    await gateway.app.close();
    first.close();

    const recovered = openControlPlane();
    expect(recovered.messages.getDelivery(queued.delivery.id)).toMatchObject({
      state: 'pending',
      attemptCount: 0,
    });
    expect(recovered.tasks.getTask('worker-task')).toMatchObject({
      state: 'completed',
      resultArtifactRefs: [published.artifact.id],
    });
    const loaded = await recovered.artifacts.load(published.artifact.id);
    expect(new TextDecoder().decode(loaded.content)).toBe(workerResult);
    expect(recovered.storage.repositories.messages.list()).toHaveLength(1);

    const resumedGateway = await startGateway(recovered);
    const resumedBoss = await startAgent(bossDefinition);
    expect(resumedBoss.handle.pid).not.toBe(boss.handle.pid);
    const resumed = await resumedGateway
      .attach(resumedBoss.connection)
      .resume(attached.session.sessionId, { ...bossContext, scopes: [...bossContext.scopes] });
    expect(resumed.session.sessionId).toBe(attached.session.sessionId);
    const claimed = await recovered.router.claimNext(bossDefinition.id);
    expect(claimed?.message).toEqual(queued.message);
    expect(claimed?.delivery.attemptCount).toBe(1);
    expect(claimed).toBeDefined();
    recovered.tasks.transitionTask('root-task', 'running');
    const final = JSON.parse(
      await promptText(
        resumedBoss.connection,
        resumed.session.sessionId,
        JSON.stringify({ action: 'complete', message: claimed!.message }),
      ),
    );
    expect(final).toEqual({
      final: `Final answer incorporates the durable worker result: ${workerResult}`,
      artifactId: published.artifact.id,
      messageId: queued.message.id,
    });
    recovered.tasks.completeTask('root-task', [published.artifact.id]);
    await recovered.router.acknowledge(claimed!.delivery.id, claimed!.delivery.attemptCount);
    expect(recovered.messages.getDelivery(queued.delivery.id)?.state).toBe('delivered');
    expect(await recovered.router.claimNext(bossDefinition.id)).toBeUndefined();
    expect(
      audit.filter((record) => record.outcome === 'succeeded').map((record) => record.toolName),
    ).toEqual([
      'control_discover_agents',
      'control_create_task',
      'control_delegate_task',
      'control_get_task',
      'control_get_artifact',
    ]);
    expect(audit.every((record) => record.identity.sessionId === attached.session.sessionId)).toBe(
      true,
    );

    await resumedBoss.stop();
    await resumedGateway.app.close();
    recovered.close();
    const verified = openControlPlane();
    expect(verified.tasks.getTask('root-task').state).toBe('completed');
    expect(verified.messages.getDelivery(queued.delivery.id)?.state).toBe('delivered');
    expect(await verified.router.claimNext(bossDefinition.id)).toBeUndefined();
    for (const handle of [
      boss.handle,
      worker.handle,
      resumedBoss.handle,
    ] satisfies ProcessHandle[]) {
      expect(runner.status(handle).state).not.toBe('running');
    }
  }, 30_000);
});
