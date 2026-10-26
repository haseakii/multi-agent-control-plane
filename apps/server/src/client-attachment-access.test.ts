import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'client-attachment-access-'));
  const filename = join(root, 'state.sqlite');
  let storage = openSqliteStorage({ filename });
  const token = 'a'.repeat(64);
  const access = {
    version: 1,
    clients: [
      {
        id: 'client',
        name: 'Project client',
        enabled: true,
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        projects: [{ projectId: 'p' }, { projectId: 'private' }],
        tools: clientToolDefinitions.map((tool) => tool.name),
      },
    ],
  };
  const createRuntime = () =>
    createControlPlaneRuntime({
      storage,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
  let runtime = createRuntime();
  const createApp = () =>
    buildServer({
      taskControl: runtime,
      clientGateway: { storage, runtime, readAccess: () => access },
    });
  let app = createApp();
  runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
  runtime.createProject({ id: 'p', name: 'Shared project' });
  runtime.createProject({ id: 'private', name: 'Other project' });
  runtime.setWorkspaceMode('p', { mode: 'task-local' });
  runtime.agentControl.create({
    id: 'worker',
    name: 'Synthetic worker',
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/client-worker-agent.mjs', import.meta.url))],
    },
    auth: { mode: 'agent-managed' },
    capabilities: [],
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
  const call = (toolName: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + token },
      payload: { toolName, input },
    });
  const upload = (projectId = 'p') => {
    const bytes = Buffer.from('Synthetic reference content');
    const query = new URLSearchParams({
      toolName: 'collaboration_submit_task',
      projectId,
      idempotencyKey: 'upload',
      slot: '0',
      name: 'input.txt',
      mimeType: 'text/plain',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return app.inject({
      method: 'POST',
      url: '/internal/client/input-attachments?' + query,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
  };
  const close = async () => {
    await runtime.close();
    await app.close();
    storage.close();
    if (!root.startsWith(join(tmpdir(), 'client-attachment-access-')))
      throw Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  };
  return {
    get storage() {
      return storage;
    },
    get runtime() {
      return runtime;
    },
    access,
    call,
    upload,
    close,
    restart: async () => {
      await runtime.close();
      await app.close();
      storage.close();
      storage = openSqliteStorage({ filename });
      runtime = createRuntime();
      app = createApp();
      runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
    },
  };
}

it.each([
  'private-bound',
  'owner-unbound',
  'other-client-unbound',
  'other-project-unbound',
  'missing',
] as const)(
  'rejects %s attachment references before submitting or continuing work',
  async (source) => {
    const f = fixture();
    try {
      let attachmentId: string = randomUUID();
      if (source === 'other-client-unbound' || source === 'other-project-unbound') {
        const uploaded = await f.upload(source === 'other-project-unbound' ? 'private' : 'p');
        expect(uploaded.statusCode, uploaded.body).toBe(200);
        attachmentId = uploaded.json().attachment.id;
        if (source === 'other-client-unbound') f.access.clients[0]!.id = 'another-client';
      } else if (source !== 'missing') {
        const attachment = f.runtime.inputAttachments.upload(
          'private.txt',
          'text/plain',
          Buffer.from('Private reference'),
        );
        attachmentId = attachment.id;
        if (source === 'private-bound') {
          const task = f.runtime.taskEngine.createTask({
            id: 'private-task',
            projectId: 'private',
            title: 'Private task',
            objective: 'Keep private input',
            state: 'ready',
          });
          f.runtime.inputAttachments.repository.bind(task.id, task.id, [attachment.id]);
        }
      }
      // Even authorization for both projects does not authorize transplanting an input.
      const tasksBefore = f.storage.repositories.tasks.list().length;
      const input = {
        projectId: 'p',
        agentId: 'worker',
        objective: 'Read references',
        idempotencyKey: 'unauthorized',
        attachmentIds: [attachmentId],
      };
      expect((await f.call('collaboration_submit_task', input)).statusCode).toBe(403);
      expect(f.storage.repositories.tasks.list()).toHaveLength(tasksBefore);
      const draft = f.runtime.taskEngine.createTask({
        id: 'ended',
        projectId: 'p',
        title: 'Ended',
        objective: 'Previous work',
        state: 'ready',
      });
      f.runtime.taskEngine.cancelTask(draft.id);
      expect(
        (
          await f.call('collaboration_continue_task', {
            taskId: draft.id,
            content: 'Continue',
            idempotencyKey: 'continue',
            attachmentIds: [attachmentId],
          })
        ).statusCode,
      ).toBe(403);
      expect(f.storage.repositories.tasks.list()).toHaveLength(tasksBefore + 1);
    } finally {
      await f.close();
    }
  },
);

it('keeps upload authority and same-project legacy bindings usable across restart', async () => {
  const f = fixture();
  try {
    const uploaded = await f.upload();
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const freshId = uploaded.json().attachment.id as string;
    const legacy = f.runtime.inputAttachments.upload(
      'legacy.txt',
      'text/plain',
      Buffer.from('Legacy input'),
    );
    const ownerTask = f.runtime.taskEngine.createTask({
      id: 'owner-task',
      projectId: 'p',
      title: 'Owner task',
      objective: 'Existing task',
      state: 'ready',
    });
    f.runtime.inputAttachments.repository.bind(ownerTask.id, ownerTask.id, [legacy.id]);
    await f.restart();
    const input = {
      projectId: 'p',
      agentId: 'worker',
      objective: 'Read shared inputs',
      idempotencyKey: 'authorized',
      attachmentIds: [freshId, legacy.id],
    };
    const submitted = await f.call('collaboration_submit_task', input);
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(
      f.runtime.taskInputAttachments(submitted.json().result.task.id).map((a) => a.id),
    ).toEqual([freshId, legacy.id]);
    expect((await f.call('collaboration_submit_task', input)).json().result.reused).toBe(true);
    await expect
      .poll(() => f.runtime.taskExecutionActive(submitted.json().result.task.id), {
        timeout: 10000,
      })
      .toBe(false);
  } finally {
    await f.close();
  }
}, 20000);

it('rolls back a new upload when its authorization audit cannot be persisted', async () => {
  const f = fixture();
  try {
    vi.spyOn(f.storage.repositories.events, 'append').mockImplementationOnce(() => {
      throw Error('Synthetic storage failure');
    });
    expect((await f.upload()).statusCode).toBe(409);
    expect(
      f.storage.sqlite.prepare('SELECT count(*) AS count FROM input_attachments').get(),
    ).toEqual({ count: 0 });
    expect(
      f.storage.repositories.events
        .listByProject('p')
        .filter((event) => event.type === 'client.input.uploaded'),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
