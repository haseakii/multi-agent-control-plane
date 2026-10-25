import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
it('uses shared real process routes for probes and execution, then retries and follows up with new routes without losing files or context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'network-runtime-')),
    filename = join(root, 'state.sqlite'),
    trace = join(root, 'trace.jsonl');
  const servers: Server[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const hits: Record<string, string[]> = { a: [], b: [] };
  async function proxy(via: string) {
    const server = createServer((request, response) => {
      hits[via]!.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ via }));
    });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('connect', (request, socket, head) => {
      if (request.url !== 'network-fixture.invalid:80') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let buffered = Buffer.alloc(0);
      const received = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!buffered.includes('\r\n\r\n')) return;
        socket.removeListener('data', received);
        const path = buffered.toString('utf8').split(' ')[1] ?? '/';
        hits[via]!.push('http://network-fixture.invalid' + path);
        const body = JSON.stringify({ via });
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      };
      socket.on('data', received);
      socket.on('error', () => {});
      if (head.length) received(head);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  }
  let storage = openSqliteStorage({ filename });
  const options = () => ({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  let runtime = createControlPlaneRuntime(options());
  runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  try {
    const a = await proxy('a'),
      b = await proxy('b');
    runtime.createProject({ id: 'p', name: 'Network fixture' });
    runtime.setWorkspaceMode('p', { mode: 'task-local' });
    runtime.agentControl.create({
      id: 'worker',
      name: 'Network fixture',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/network-worker.mjs', import.meta.url)), trace],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    });
    const policy = JSON.stringify(runtime.getProjectPolicy('p'));
    runtime.network.save({
      expectedRevision: 0,
      global: { mode: 'proxy', proxyUrl: a },
      members: {},
    });
    const probe = await runtime.agentControl.probe('worker');
    expect(probe.readiness.runtime, JSON.stringify(hits)).toBe('ready');
    await runtime.sessionSettings.inspect('worker', 'p');
    expect(hits.a).toContain('http://network-fixture.invalid/initialize');
    expect(hits.a).toContain('http://network-fixture.invalid/new');
    expect(runtime.sessionSettings.read('worker', 'p').freshness).toBe('fresh');
    const first = runtime.submitClientTask('fixture-client', {
      projectId: 'p',
      agentId: 'worker',
      objective: 'INJECT_ONE_FAILURE then retain files',
      idempotencyKey: 'first',
    });
    const settled = async (taskId: string, state: string) => {
      await expect.poll(() => runtime.getTask(taskId).state, { timeout: 10000 }).toBe(state);
      await expect.poll(() => runtime.taskExecutionActive(taskId), { timeout: 10000 }).toBe(false);
    };
    await settled(first.task.id, 'failed');
    const original = runtime.taskRecovery(first.task.id).network;
    expect(original.current).toMatchObject({
      state: 'started',
      effective: { proxyUrl: a },
      trafficVerified: false,
    });
    runtime.network.save({
      expectedRevision: 1,
      global: { mode: 'proxy', proxyUrl: b },
      members: {},
    });
    expect(runtime.sessionSettings.read('worker', 'p')).toMatchObject({
      freshness: 'stale',
      staleReason: 'network-changed',
    });
    expect(runtime.taskRecovery(first.task.id).network.changedForNext).toBe(true);
    runtime.resumeTask(first.task.id, {});
    await settled(first.task.id, 'completed');
    const attempts = storage.repositories.executionAttempts
      .list()
      .filter((v) => v.taskId === first.task.id)
      .sort((left, right) => left.number - right.number);
    expect(attempts).toHaveLength(2);
    expect(runtime.network.repository.getAttempt(attempts[0]!.id)?.effective.proxyUrl).toBe(a);
    expect(runtime.network.repository.getAttempt(attempts[1]!.id)?.effective.proxyUrl).toBe(b);
    const beforeClose = runtime.taskRecovery(first.task.id).network.current;
    await runtime.close();
    storage.close();
    storage = openSqliteStorage({ filename });
    runtime = createControlPlaneRuntime(options());
    runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
    expect(runtime.taskRecovery(first.task.id).network.current).toEqual(beforeClose);
    const second = runtime.followUpTask(first.task.id, {
      content: 'Keep retained.txt and add followup.txt',
      idempotencyKey: 'followup',
    });
    await settled(second.task.id, 'completed');
    const binding = storage.repositories.assignmentWorkspaces
      .list()
      .find((v) => v.taskId === second.task.id)!;
    const workspace = storage.repositories.workspaces.get(binding.workspaceId)!;
    expect(readFileSync(join(workspace.rootPath, 'retained.txt'), 'utf8')).toBe(
      'retained before failure',
    );
    expect(readFileSync(join(workspace.rootPath, 'followup.txt'), 'utf8')).toBe(
      'context and files retained',
    );
    expect(readFileSync(trace, 'utf8')).toContain('"previousGoal":true');
    expect(hits.b).toContain('http://network-fixture.invalid/prompt');
    expect(JSON.stringify(runtime.getProjectPolicy('p'))).toBe(policy);
  } finally {
    await runtime.close();
    if (storage.sqlite.open) storage.close();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    const target = resolve(root);
    if (
      !target.startsWith(resolve(tmpdir()) + '\\network-runtime-') &&
      !target.startsWith(resolve(tmpdir()) + '/network-runtime-')
    )
      throw Error('Unexpected fixture root');
    rmSync(target, { recursive: true, force: true });
  }
}, 35000);
