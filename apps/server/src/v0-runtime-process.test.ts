import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDefinitionSchema, type Task } from '@control-plane/core';
import { SqliteMessageRouterStore } from '@control-plane/message-router';
import { LocalRunner, type ProcessHandle } from '@control-plane/runner';
import { openSqliteStorage } from '@control-plane/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-v0-runtime-'));
  const storage = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
  const runner = new LocalRunner();
  const handles: ProcessHandle[] = [];
  const spawn = runner.spawn.bind(runner);
  runner.spawn = async (spec) => {
    const handle = await spawn(spec);
    handles.push(handle);
    return handle;
  };
  const runtime = createControlPlaneRuntime({
    storage,
    runner,
    artifactRoot: join(directory, 'artifacts'),
    workspaceRoot: join(directory, 'workspaces'),
    executionTimeoutMs: 20_000,
  });
  const app = buildServer({
    agentControl: runtime.agentControl,
    taskControl: runtime,
    fleetGateway: runtime.fleetGateway,
  });
  cleanup.push(async () => {
    await runtime.close();
    await app.close();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
  return { app, runtime, storage, runner, handles };
}

function agentDefinition(boss: boolean) {
  return AgentDefinitionSchema.parse({
    id: boss ? 'runtime-boss' : 'runtime-worker',
    name: boss ? 'Runtime Boss' : 'Runtime Worker',
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL(
            `../fixtures/${boss ? 'runtime-boss-agent' : 'worker-agent'}.mjs`,
            import.meta.url,
          ),
        ),
      ],
    },
    auth: { mode: 'agent-managed' },
    capabilities: [{ name: boss ? 'planning' : 'code.review', source: 'verified' }],
    orchestration: { canBeBoss: boss },
    controlBridge: boss
      ? { transport: 'mcp', scopes: ['boss.orchestration', 'artifact.read'] }
      : { transport: 'none', scopes: [] },
  });
}

describe('production V0 runtime with real ACP processes', () => {
  it('accepts a goal through HTTP and executes discovery, delegation and artifact-backed continuation without test-side orchestration', async () => {
    const { app, storage, runner, handles } = await fixture();
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'runtime-project', name: 'Production acceptance' },
    });
    expect(project.statusCode).toBe(201);
    for (const boss of [true, false]) {
      const registered = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: agentDefinition(boss),
      });
      expect(registered.statusCode).toBe(201);
      const probed = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentDefinition(boss).id}/probe`,
      });
      expect(probed.json().readiness.runtime).toBe('ready');
    }
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/projects/runtime-project/boss',
          payload: { agentId: 'runtime-boss' },
        })
      ).statusCode,
    ).toBe(200);
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/projects/runtime-project/goals',
      payload: { objective: 'Complete the production acceptance goal.' },
    });
    expect(submitted.statusCode).toBe(202);
    const rootId: string = submitted.json().task.id;
    let task: Task | undefined;
    await expect
      .poll(
        async () => {
          const response = await app.inject({ method: 'GET', url: `/api/tasks/${rootId}` });
          task = response.json<Task>();
          return ['completed', 'failed'].includes(task.state);
        },
        { timeout: 15_000, interval: 50 },
      )
      .toBe(true);

    if (task?.state !== 'completed') {
      const diagnostics = [];
      for (const handle of handles) {
        await runner.stop(handle);
        for await (const event of runner.events(handle, { replay: true })) {
          if (
            event.type === 'process.stdout' ||
            event.type === 'process.stderr' ||
            event.type === 'process.exited'
          ) {
            diagnostics.push(event);
          }
        }
      }
      expect(
        task?.state,
        JSON.stringify(
          { diagnostics, events: storage.repositories.events.listByProject('runtime-project') },
          null,
          2,
        ),
      ).toBe('completed');
    }

    const root = task!;
    expect(root.resultArtifactRefs).toHaveLength(1);
    const content = await app.inject({
      method: 'GET',
      url: `/api/artifacts/${root.resultArtifactRefs[0]}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe(
      'Production final: Worker review: boundaries are consistent. 验收通过 ✓',
    );
    const child = storage.repositories.tasks.list().find((item) => item.parentTaskId === rootId)!;
    expect(child.state).toBe('completed');
    expect(child.resultArtifactRefs).toHaveLength(1);
    expect(
      storage.repositories.assignments
        .list()
        .map((item) => item.agentId)
        .sort(),
    ).toEqual(['runtime-boss', 'runtime-worker']);
    const messages = await app.inject({ method: 'GET', url: `/api/tasks/${child.id}/messages` });
    expect(messages.json()).toEqual([
      expect.objectContaining({
        fromAgentId: 'runtime-worker',
        toAgentId: 'runtime-boss',
        artifactRefs: child.resultArtifactRefs,
      }),
    ]);
    const events = await app.inject({ method: 'GET', url: `/api/tasks/${rootId}/events` });
    expect(events.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'fleet.tool',
          payload: expect.objectContaining({ outcome: 'denied' }),
        }),
        expect.objectContaining({
          type: 'fleet.tool',
          payload: expect.objectContaining({
            toolName: 'control_delegate_task',
            outcome: 'succeeded',
            enforcementMode: 'enforced',
          }),
        }),
        expect.objectContaining({
          type: 'execution.boundary',
          payload: expect.objectContaining({ enforcementMode: 'unavailable' }),
        }),
      ]),
    );
    expect(
      storage.repositories.executionAttempts
        .list()
        .every((attempt) => attempt.state === 'completed'),
    ).toBe(true);
  }, 30_000);

  it.each(['idle', 'active'])(
    'routes worker A to %s worker B with messaging-only grants and rejects escalation',
    async (receiverState) => {
      const { app, runtime, storage, runner, handles } = await fixture();
      runtime.createProject({ id: 'messaging-project', name: 'Scoped worker messaging' });
      for (const role of ['boss', 'a', 'b']) {
        const boss = role === 'boss';
        runtime.agentControl.create({
          ...agentDefinition(boss),
          id: `messenger-${role}`,
          name: `Messenger ${role}`,
          runtime: {
            type: 'acp-stdio',
            command: process.execPath,
            args: [
              fileURLToPath(new URL('../fixtures/messaging-agent.mjs', import.meta.url)),
              role,
              receiverState,
            ],
          },
          capabilities: [
            {
              name: boss ? 'planning' : role === 'a' ? 'message.coordinate' : 'message.respond',
              source: 'verified',
            },
          ],
          controlBridge: boss
            ? { transport: 'mcp', scopes: ['boss.orchestration', 'artifact.read'] }
            : { transport: 'mcp', scopes: ['agent.messaging'] },
        });
        const probe = await runtime.agentControl.probe(`messenger-${role}`);
        expect(probe.readiness.runtime).toBe('ready');
      }
      runtime.agentControl.selectBoss('messaging-project', 'messenger-boss');
      const submitted = await app.inject({
        method: 'POST',
        url: '/api/projects/messaging-project/goals',
        payload: { objective: 'Prove mediated worker-to-worker messaging.' },
      });
      expect(submitted.statusCode).toBe(202);
      const rootId: string = submitted.json().task.id;
      await expect
        .poll(() => ['completed', 'failed'].includes(runtime.getTask(rootId).state), {
          timeout: 15_000,
          interval: 50,
        })
        .toBe(true);
      if (runtime.getTask(rootId).state !== 'completed') {
        const diagnostics = [];
        for (const handle of handles) {
          await runner.stop(handle);
          for await (const event of runner.events(handle, { replay: true })) {
            if (event.type === 'process.stdout' || event.type === 'process.stderr') {
              diagnostics.push(event);
            }
          }
        }
        expect(runtime.getTask(rootId).state, JSON.stringify(diagnostics, null, 2)).toBe(
          'completed',
        );
      }
      const content = await runtime.loadArtifact(runtime.getTask(rootId).resultArtifactRefs[0]!);
      expect(new TextDecoder().decode(content.content)).toBe(
        'Messaging final: Worker A received B response through the durable router.',
      );
      const messages = storage.repositories.messages.list();
      const request = messages.find(
        (message) => message.content === 'Please acknowledge the mediated request.',
      );
      const response = messages.find((message) => message.content === 'B response: acknowledged.');
      expect(request).toMatchObject({
        fromAgentId: 'messenger-a',
        toAgentId: 'messenger-b',
        type: 'request',
      });
      expect(response).toMatchObject({
        fromAgentId: 'messenger-b',
        toAgentId: 'messenger-a',
        type: 'response',
      });
      expect(messages.some((message) => message.content === 'This must be rejected.')).toBe(false);
      const rows = storage.sqlite.prepare('SELECT state FROM message_deliveries').all() as Array<{
        state: string;
      }>;
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.every((row) => row.state === 'delivered')).toBe(true);
      expect(
        storage.repositories.assignments
          .list()
          .map((assignment) => assignment.agentId)
          .sort(),
      ).toEqual(['messenger-a', 'messenger-b', 'messenger-boss']);
      expect(storage.repositories.events.listByProject('messaging-project')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fleet.tool',
            payload: expect.objectContaining({
              toolName: 'control_send_message',
              outcome: 'denied',
            }),
          }),
        ]),
      );
    },
    30_000,
  );

  it.each(['artifact', 'completion'])(
    'recovers already-acknowledged worker context after a %s failure',
    async (failureStage) => {
      const { app, runtime, storage } = await fixture();
      runtime.createProject({ id: 'recovery-project', name: 'ACK to artifact recovery' });
      for (const boss of [true, false]) {
        runtime.agentControl.create(agentDefinition(boss));
        expect((await runtime.agentControl.probe(agentDefinition(boss).id)).readiness.runtime).toBe(
          'ready',
        );
      }
      runtime.agentControl.selectBoss('recovery-project', 'runtime-boss');
      const publish = runtime.artifacts.publish.bind(runtime.artifacts);
      const complete = runtime.taskEngine.completeTask.bind(runtime.taskEngine);
      const failure =
        failureStage === 'artifact'
          ? vi.spyOn(runtime.artifacts, 'publish').mockImplementation(async (input) => {
              if (input.producerAgentId === 'runtime-boss')
                throw new Error('Injected artifact failure after ACK.');
              return publish(input);
            })
          : vi.spyOn(runtime.taskEngine, 'completeTask').mockImplementation((taskId, refs) => {
              if (!runtime.getTask(taskId).parentTaskId)
                throw new Error('Injected task completion failure.');
              return complete(taskId, refs);
            });
      const submitted = await app.inject({
        method: 'POST',
        url: '/api/projects/recovery-project/goals',
        payload: { objective: 'Complete the production acceptance goal.' },
      });
      expect(submitted.statusCode).toBe(202);
      const rootId: string = submitted.json().task.id;
      await expect
        .poll(() => runtime.getTask(rootId).state, { timeout: 15_000, interval: 50 })
        .toBe('failed');
      const child = storage.repositories.tasks.list().find((task) => task.parentTaskId === rootId)!;
      expect(child.state).toBe('completed');
      expect(
        storage.repositories.executionAttempts.list().find((attempt) => attempt.taskId === rootId)
          ?.state,
      ).toBe('failed');
      const [message] = storage.repositories.messages.list();
      expect(message).toBeDefined();
      const deliveries = new SqliteMessageRouterStore(storage);
      expect(deliveries.getDeliveryByMessage(message!.id)?.state).toBe('delivered');
      failure.mockRestore();

      // Retry waits for teardown of the failed ACP process, then starts a fresh
      // Boss without session/load support. Durable task input must be sufficient.
      await expect
        .poll(
          async () => {
            const resumed = await app.inject({
              method: 'POST',
              url: `/api/tasks/${rootId}/resume`,
            });
            expect([202, 409]).toContain(resumed.statusCode);
            return resumed.statusCode;
          },
          { timeout: 5_000, interval: 50 },
        )
        .toBe(202);
      await expect
        .poll(() => runtime.getTask(rootId).state, { timeout: 15_000, interval: 50 })
        .toBe('completed');
      const final = await runtime.loadArtifact(runtime.getTask(rootId).resultArtifactRefs[0]!);
      expect(new TextDecoder().decode(final.content)).toBe(
        'Production final: Worker review: boundaries are consistent. 验收通过 ✓',
      );
      expect(storage.repositories.tasks.list()).toHaveLength(2);
      expect(storage.repositories.assignments.list()).toHaveLength(2);
      expect(storage.repositories.executionAttempts.list()).toHaveLength(3);
      expect(storage.repositories.messages.list()).toHaveLength(1);
      expect(deliveries.getDeliveryByMessage(message!.id)).toMatchObject({
        state: 'delivered',
        attemptCount: 1,
      });
    },
    30_000,
  );

  it.each(['approve', 'reject'])(
    'waits for the real ACP permission decision and honors %s',
    async (decision) => {
      const { app, runtime } = await fixture();
      runtime.createProject({ id: 'permission-project', name: 'ACP permission acceptance' });
      runtime.agentControl.create({
        ...agentDefinition(true),
        runtime: {
          type: 'acp-stdio',
          command: process.execPath,
          args: [fileURLToPath(new URL('../fixtures/permission-agent.mjs', import.meta.url))],
        },
      });
      runtime.agentControl.selectBoss('permission-project', 'runtime-boss');
      const submitted = await app.inject({
        method: 'POST',
        url: '/api/projects/permission-project/goals',
        payload: { objective: decision },
      });
      expect(submitted.statusCode).toBe(202);
      const rootId: string = submitted.json().task.id;
      await expect
        .poll(() => runtime.getTask(rootId).state, { timeout: 5_000, interval: 25 })
        .toBe('waiting_approval');
      const pending = await app.inject({ method: 'GET', url: '/api/approvals?state=pending' });
      expect(pending.json()).toHaveLength(1);
      const approval = pending.json()[0];
      expect(approval).toMatchObject({
        taskId: rootId,
        state: 'pending',
        enforcementMode: 'cooperative',
        boundary: 'acp-permission',
      });
      expect(runtime.getTask(rootId).resultArtifactRefs).toEqual([]);
      const resolved = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/${decision}`,
        payload: {},
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().state).toBe(decision === 'approve' ? 'approved' : 'rejected');
      await expect
        .poll(() => runtime.getTask(rootId).state, { timeout: 5_000, interval: 25 })
        .toBe('completed');
      const artifact = await runtime.loadArtifact(runtime.getTask(rootId).resultArtifactRefs[0]!);
      expect(new TextDecoder().decode(artifact.content)).toBe(
        decision === 'approve'
          ? 'Permission approved once.'
          : 'Permission rejected; no operation performed.',
      );
    },
    15_000,
  );

  it('rejects a no-bridge Boss and leaves no executable goal behind', async () => {
    const { app, storage } = await fixture();
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'no-bridge-project', name: 'No bridge' },
    });
    const definition = agentDefinition(true);
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...definition, controlBridge: { transport: 'none', scopes: [] } },
    });
    const selected = await app.inject({
      method: 'PUT',
      url: '/api/projects/no-bridge-project/boss',
      payload: { agentId: definition.id },
    });
    expect(selected.statusCode).toBe(400);
    expect(selected.json().error).toContain('not eligible');
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/projects/no-bridge-project/goals',
      payload: { objective: 'Must not execute.' },
    });
    expect(submitted.statusCode).toBe(409);
    expect(storage.repositories.tasks.list()).toHaveLength(0);
    expect(storage.repositories.executionAttempts.list()).toHaveLength(0);
  });
});
