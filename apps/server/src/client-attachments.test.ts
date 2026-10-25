import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openSqliteStorage } from '@control-plane/storage';
import {
  clientToolDefinitions,
  createClientMcpServer,
  createClientHttpTransport,
} from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

it('MCP uploads actual local image/file bytes once per sending key, retains inputs and changes through followup, and rejects unauthorized imports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'client-inputs-')),
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const token = 'b'.repeat(64),
    access = {
      version: 1,
      clients: [
        {
          id: 'client',
          name: 'Fixture',
          enabled: true,
          tokenSha256: createHash('sha256').update(token).digest('hex'),
          projects: [{ projectId: 'p' }],
          tools: clientToolDefinitions.map((t) => t.name),
        },
      ],
    };
  const app = buildServer({
    taskControl: runtime,
    clientGateway: { storage, runtime, readAccess: () => access },
  });
  let client: Client | undefined, server: ReturnType<typeof createClientMcpServer> | undefined;
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    runtime.setBridgeBaseUrl(url);
    runtime.createProject({ id: 'p', name: 'MCP image inputs' });
    runtime.createProject({ id: 'private', name: 'Private' });
    runtime.setWorkspaceMode('p', { mode: 'task-local' });
    runtime.agentControl.create({
      id: 'worker',
      name: 'Image fixture',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/input-worker.mjs', import.meta.url))],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]),
      image = join(root, 'image.png'),
      notes = join(root, 'notes.txt');
    writeFileSync(image, png);
    writeFileSync(notes, 'retain blue-pine-37');
    const transport = createClientHttpTransport(url, token);
    server = createClientMcpServer(transport);
    client = new Client({ name: 'Fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const request = {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Read attached files',
      idempotencyKey: 'first',
      attachments: [{ path: image }, { path: notes }],
    };
    const first = await client.callTool({ name: 'collaboration_submit_task', arguments: request });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    const firstId = (first.structuredContent as { task: { id: string } }).task.id;
    await expect.poll(() => runtime.getTask(firstId).state, { timeout: 10000 }).toBe('completed');
    await expect.poll(() => runtime.taskExecutionActive(firstId), { timeout: 10000 }).toBe(false);
    const inputs = runtime.taskInputAttachments(firstId);
    expect(inputs.map((i) => i.name)).toEqual(['image.png', 'notes.txt']);
    expect(Buffer.from(runtime.inputAttachments.repository.read(inputs[0]!.id))).toEqual(png);
    expect((await transport.invoke('collaboration_submit_task', request)).task).toMatchObject({
      id: firstId,
    });
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM input_attachments').get()).toEqual({
      n: 2,
    });
    writeFileSync(notes, 'changed request');
    await expect(transport.invoke('collaboration_submit_task', request)).rejects.toThrow(
      '发送编号',
    );
    writeFileSync(notes, 'retain blue-pine-37');
    const second = (
      await transport.invoke('collaboration_continue_task', {
        taskId: firstId,
        content: 'Continue using the original inputs',
        idempotencyKey: 'followup',
      })
    ).task as { id: string };
    await expect.poll(() => runtime.getTask(second.id).state, { timeout: 10000 }).toBe('completed');
    await expect.poll(() => runtime.taskExecutionActive(second.id), { timeout: 10000 }).toBe(false);
    expect(runtime.taskInputAttachments(second.id).map((i) => i.id)).toEqual(
      inputs.map((i) => i.id),
    );
    const binding = storage.repositories.assignmentWorkspaces
      .list()
      .find((w) => w.taskId === second.id)!;
    const workspace = storage.repositories.workspaces.get(binding.workspaceId)!;
    expect(readFileSync(join(workspace.rootPath, 'input-proof.txt'), 'utf8')).toContain(
      'blue-pine-37',
    );
    expect(readFileSync(join(workspace.rootPath, 'followup-proof.txt'), 'utf8')).toContain(
      'native image',
    );
    await expect(
      createClientHttpTransport(url, 'c'.repeat(64)).invoke('collaboration_submit_task', request),
    ).rejects.toThrow('missing or revoked');
    await expect(
      transport.invoke('collaboration_submit_task', {
        ...request,
        projectId: 'private',
        idempotencyKey: 'forbidden',
      }),
    ).rejects.toThrow('not authorized');
    await expect(
      transport.invoke('collaboration_continue_task', {
        taskId: firstId,
        content: 'new input',
        idempotencyKey: 'bad-directory',
        attachments: [{ path: root }],
      }),
    ).rejects.toThrow('regular file');
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM input_attachments').get()).toEqual({
      n: 2,
    });
  } finally {
    await client?.close();
    await server?.close();
    await app.close();
    await runtime.close();
    storage.close();
    if (
      !resolve(root).startsWith(
        resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'client-inputs-',
      )
    )
      throw Error('Unexpected fixture root');
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
