import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import {
  AcpClientRuntime,
  CapabilitySelector,
  InMemoryAgentRegistry,
} from '@control-plane/acp-runtime';
import {
  ArtifactStore,
  FilesystemArtifactBlobStore,
  SqliteArtifactMetadataStore,
} from '@control-plane/artifact-store';
import {
  AgentDefinitionSchema,
  AgentIdSchema,
  ProjectSchema,
  RunnerSchema,
} from '@control-plane/core';
import { createFleetMcpServer, type FleetControlServices } from '@control-plane/fleet-mcp';
import { MessageRouter, SqliteMessageRouterStore } from '@control-plane/message-router';
import { openSqliteStorage } from '@control-plane/storage';
import { TaskEngine } from '@control-plane/task-engine';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function streamPair(): { client: acp.Stream; agent: acp.Stream } {
  const clientToAgent = new TransformStream<acp.AnyMessage>();
  const agentToClient = new TransformStream<acp.AnyMessage>();

  return {
    client: {
      writable: clientToAgent.writable,
      readable: agentToClient.readable,
    },
    agent: {
      writable: agentToClient.writable,
      readable: clientToAgent.readable,
    },
  };
}

function fakeAgent(name: string, responseText: (prompt: string) => string) {
  return acp
    .agent({ name })
    .onRequest(acp.methods.agent.initialize, (ctx) => ({
      protocolVersion: ctx.params.protocolVersion,
      agentCapabilities: {
        loadSession: true,
      },
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => ({
      sessionId: `${name}-session-${ctx.params.cwd.replaceAll('/', '-')}`,
    }))
    .onRequest(acp.methods.agent.session.load, () => ({}))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const prompt = ctx.params.prompt
        .filter(
          (item): item is Extract<(typeof ctx.params.prompt)[number], { type: 'text' }> =>
            item.type === 'text',
        )
        .map((item) => item.text)
        .join('\n');
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: responseText(prompt),
          },
        },
      });
      return { stopReason: 'end_turn' };
    });
}

async function promptText(
  connection: Awaited<ReturnType<AcpClientRuntime['connect']>>,
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

function textFromToolResult(result: Awaited<ReturnType<Client['callTool']>>): string {
  const part = result.content.find((item) => item.type === 'text');
  if (!part || part.type !== 'text') {
    throw new Error('MCP tool result did not contain text.');
  }
  return part.text;
}

describe('V0 multi-agent integration path', () => {
  it('runs Boss discovery/delegation, worker ACP execution, durable result routing, and restart recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'control-plane-v0-'));
    directories.push(directory);
    const filename = join(directory, 'control-plane.sqlite');
    const blobRoot = join(directory, 'artifacts');

    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 9, 20, 1, 0, tick++)).toISOString();
    let eventSequence = 0;
    let messageSequence = 0;
    let artifactSequence = 0;

    const storage = openSqliteStorage({ filename });
    storage.repositories.projects.upsert(
      ProjectSchema.parse({
        id: 'e2e-project',
        name: 'V0 E2E',
        defaultBossAgentId: 'boss-agent',
        createdAt: now(),
        updatedAt: now(),
      }),
    );
    storage.repositories.runners.upsert(
      RunnerSchema.parse({
        id: 'local',
        kind: 'local',
        labels: ['e2e'],
        capabilities: ['process.spawn'],
        status: 'ready',
      }),
    );

    const bossDefinition = AgentDefinitionSchema.parse({
      id: 'boss-agent',
      name: 'Boss ACP fixture',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'boss-acp-fixture', args: [] },
      capabilities: [{ name: 'planning', source: 'verified' }],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: {
        transport: 'mcp',
        scopes: ['boss.orchestration', 'agent.messaging', 'artifact.read', 'artifact.publish'],
      },
    });
    const workerDefinition = AgentDefinitionSchema.parse({
      id: 'worker-agent',
      name: 'Worker ACP fixture',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'worker-acp-fixture', args: [] },
      capabilities: [
        { name: 'code.read', source: 'verified' },
        { name: 'code.review', source: 'verified' },
      ],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
    storage.repositories.agentDefinitions.upsert(bossDefinition);
    storage.repositories.agentDefinitions.upsert(workerDefinition);

    const registry = new InMemoryAgentRegistry();
    registry.create(bossDefinition);
    registry.create(workerDefinition);
    const readiness = new Map([
      [
        bossDefinition.id,
        {
          runtime: 'ready' as const,
          auth: 'not_reported' as const,
          observedAt: now(),
          authMethodIds: [],
        },
      ],
      [
        workerDefinition.id,
        {
          runtime: 'ready' as const,
          auth: 'not_reported' as const,
          observedAt: now(),
          authMethodIds: [],
        },
      ],
    ]);
    const selector = new CapabilitySelector(registry, {
      getReadiness: (id) => readiness.get(id),
      policyAllows: () => true,
    });

    const taskEngine = new TaskEngine(storage.repositories, {
      now,
      idFactory: (kind) => `${kind}-e2e-${++eventSequence}`,
    });
    taskEngine.createTask({
      id: 'root-task',
      projectId: 'e2e-project',
      title: 'Complete V0 goal',
      objective: 'Delegate a review and incorporate the result.',
      state: 'ready',
    });

    const router = new MessageRouter(new SqliteMessageRouterStore(storage), {
      now,
      idFactory: (kind) => `${kind}-e2e-${++messageSequence}`,
      hooks: {
        authorize: async () => ({ allowed: true }),
        audit: async () => undefined,
      },
    });
    const artifactStore = new ArtifactStore(
      new FilesystemArtifactBlobStore(blobRoot),
      new SqliteArtifactMetadataStore(storage),
      {
        now,
        idFactory: (kind) => `${kind}-e2e-${++artifactSequence}`,
      },
    );

    const bossStreams = streamPair();
    const workerStreams = streamPair();
    const bossAgentConnection = fakeAgent('boss-fixture', (prompt) =>
      prompt.includes('worker result')
        ? 'Final answer incorporates the durable worker result.'
        : 'I will discover and delegate to a capable worker.',
    ).connect(bossStreams.agent);
    const workerAgentConnection = fakeAgent(
      'worker-fixture',
      () => 'Worker review: the control-plane boundaries are consistent.',
    ).connect(workerStreams.agent);

    const bossRuntime = await new AcpClientRuntime().connect(bossStreams.client);
    const workerRuntime = await new AcpClientRuntime().connect(workerStreams.client);
    expect(bossRuntime.readiness.auth).toBe('not_reported');
    expect(workerRuntime.readiness.auth).toBe('not_reported');

    const bossSession = await bossRuntime.newSession({ cwd: '/boss' });
    const workerSession = await workerRuntime.newSession({ cwd: '/worker' });
    const bossOpening = await promptText(
      bossRuntime,
      bossSession.sessionId,
      'Complete the V0 goal.',
    );
    expect(bossOpening).toContain('discover and delegate');

    let delegatedAttemptId = '';
    const services: FleetControlServices = {
      discoverAgents: async (input) =>
        selector.select(input).map((selection) => ({
          agentId: selection.agent.id,
          matchedCapabilities: selection.matchedCapabilities.map((item) => item.name),
          score: selection.score,
        })),
      getAgent: async ({ agentId }) => registry.get(AgentIdSchema.parse(agentId)),
      createTask: async (input, context) =>
        taskEngine.createTask({
          id: 'worker-task',
          projectId: context.identity.projectId,
          parentTaskId: input.parentTaskId,
          title: input.title,
          objective: input.objective,
          state: 'ready',
          dependencyIds: input.dependencyIds,
          contextRefs: input.contextRefs,
        }),
      delegateTask: async (input) => {
        const assignment = taskEngine.createAssignment({
          id: 'worker-assignment',
          taskId: input.taskId,
          agentId: input.agentId,
          objective: input.objective ?? 'Complete delegated work.',
          role: input.role,
        });
        const attempt = taskEngine.createAttempt(assignment.id, {
          id: 'worker-attempt',
          runnerId: 'local',
        });
        delegatedAttemptId = attempt.id;
        return { assignment, attempt };
      },
      getTask: async ({ taskId }) => taskEngine.getTask(taskId),
      waitTask: async ({ taskId }) => taskEngine.getTask(taskId),
      sendMessage: async (input, context) =>
        router.send(
          {
            projectId: ProjectSchema.shape.id.parse(context.identity.projectId),
            agentId: context.identity.agentId,
          },
          {
            toAgentId: input.targetAgentId,
            taskId: input.taskId,
            type: input.type,
            content: input.content,
            artifactRefs: input.artifactRefs ?? [],
            metadata: {},
          },
        ),
      publishArtifact: async (input, context) => {
        const published = await artifactStore.publish({
          projectId: ProjectSchema.shape.id.parse(context.identity.projectId),
          taskId: input.taskId,
          producerAgentId: context.identity.agentId,
          kind: input.kind,
          mimeType: input.mimeType,
          content: new TextEncoder().encode(input.content),
          links: input.taskId ? [{ entityType: 'task', entityId: input.taskId }] : [],
        });
        return published.artifact;
      },
      getArtifact: async ({ artifactId }) => artifactStore.getMetadata(artifactId),
      requestApproval: async (input) => ({ state: 'not-required', ...input }),
      cancelTask: async ({ taskId }) => taskEngine.cancelTask(taskId),
    };

    const fleetServer = createFleetMcpServer({
      identity: {
        agentId: bossDefinition.id,
        projectId: 'e2e-project',
        sessionId: bossSession.sessionId,
        taskId: 'root-task',
      },
      agent: bossDefinition,
      services,
      hooks: {
        authorize: async () => ({ allowed: true }),
        audit: async () => undefined,
      },
    });
    const fleetClient = new Client(
      { name: 'v0-e2e-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([fleetClient.connect(clientTransport), fleetServer.connect(serverTransport)]);

    const discovery = await fleetClient.callTool({
      name: 'control_discover_agents',
      arguments: { exact: ['code.review'] },
    });
    expect(JSON.parse(textFromToolResult(discovery))).toEqual([
      {
        agentId: 'worker-agent',
        matchedCapabilities: ['code.review'],
        score: 1,
      },
    ]);

    await fleetClient.callTool({
      name: 'control_create_task',
      arguments: {
        title: 'Review control-plane boundaries',
        objective: 'Review the boundaries and return a durable result.',
        parentTaskId: 'root-task',
      },
    });
    await fleetClient.callTool({
      name: 'control_delegate_task',
      arguments: {
        taskId: 'worker-task',
        agentId: 'worker-agent',
        role: { name: 'boundary reviewer' },
      },
    });

    taskEngine.startAttempt(delegatedAttemptId);
    taskEngine.attachConversation({
      id: 'worker-conversation',
      executionAttemptId: delegatedAttemptId,
      runnerId: 'local',
      protocol: 'acp',
      sessionId: workerSession.sessionId,
    });
    const workerResult = await promptText(
      workerRuntime,
      workerSession.sessionId,
      'Review the control-plane boundaries.',
    );
    expect(workerResult).toContain('boundaries are consistent');

    const published = await artifactStore.publish({
      projectId: ProjectSchema.shape.id.parse('e2e-project'),
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
    taskEngine.finishAttempt(delegatedAttemptId, { outcome: 'completed' });
    taskEngine.completeTask('worker-task', [published.artifact.id]);

    const response = await router.send(
      {
        projectId: ProjectSchema.shape.id.parse('e2e-project'),
        agentId: workerDefinition.id,
      },
      {
        toAgentId: bossDefinition.id,
        taskId: 'worker-task',
        type: 'response',
        content: workerResult,
        artifactRefs: [published.artifact.id],
        metadata: {},
        idempotencyKey: 'worker-result',
      },
    );
    const claimed = await router.claimNext(bossDefinition.id);
    expect(claimed?.message.id).toBe(response.message.id);
    await router.acknowledge(claimed!.delivery.id, claimed!.delivery.attemptCount);

    taskEngine.transitionTask('root-task', 'running');
    const bossFinal = await promptText(
      bossRuntime,
      bossSession.sessionId,
      `Continue with worker result: ${workerResult}`,
    );
    expect(bossFinal).toContain('Final answer');
    taskEngine.completeTask('root-task', [published.artifact.id]);

    await Promise.all([fleetClient.close(), fleetServer.close()]);
    bossRuntime.close();
    workerRuntime.close();
    bossAgentConnection.close();
    workerAgentConnection.close();
    storage.close();

    const reopened = openSqliteStorage({ filename });
    expect(reopened.repositories.tasks.get('root-task')?.state).toBe('completed');
    expect(reopened.repositories.tasks.get('worker-task')?.state).toBe('completed');
    expect(reopened.repositories.messages.list()).toHaveLength(1);
    expect(reopened.repositories.artifacts.get(published.artifact.id)?.producerAgentId).toBe(
      'worker-agent',
    );

    const reopenedArtifacts = new ArtifactStore(
      new FilesystemArtifactBlobStore(blobRoot),
      new SqliteArtifactMetadataStore(reopened),
      {
        now,
        idFactory: (kind) => `${kind}-reopen-${++artifactSequence}`,
      },
    );
    const loaded = await reopenedArtifacts.load(published.artifact.id);
    expect(new TextDecoder().decode(loaded.content)).toBe(workerResult);
    reopened.close();
  });
});
