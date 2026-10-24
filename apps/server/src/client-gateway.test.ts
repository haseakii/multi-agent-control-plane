import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

it.each(['git-worktree', 'task-local'] as const)(
  'external MCP delegates and continues %s work across restart without merging the previous round',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'client-workflow-')),
      filename = join(root, 'state.sqlite');
    let storage = openSqliteStorage({ filename });
    const options = () => ({
      storage,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
    let runtime = createControlPlaneRuntime(options());
    const token = 'd'.repeat(64),
      access = {
        version: 1,
        clients: [
          {
            id: 'test',
            name: 'External client',
            enabled: true,
            tokenSha256: createHash('sha256').update(token).digest('hex'),
            projects: [{ projectId: 'p' }],
            tools: clientToolDefinitions.map((t) => t.name),
          },
        ],
      };
    const build = () =>
      buildServer({
        taskControl: runtime,
        clientGateway: { storage, runtime, readAccess: () => access },
      });
    let app = build();
    const call = (toolName: string, input: unknown, bearer = token) =>
      app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: 'Bearer ' + bearer },
        payload: { toolName, input },
      });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
    try {
      runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
      runtime.createProject({ id: 'p', name: 'MCP work' });
      runtime.createProject({ id: 'private', name: 'Not shared' });
      const source = storage.repositories.workspaces.get(
        storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId,
      )!;
      if (mode === 'git-worktree') {
        git(source.rootPath, 'init', '-b', 'main');
        git(source.rootPath, 'config', 'core.autocrlf', 'false');
        git(source.rootPath, 'config', 'user.name', 'Test');
        git(source.rootPath, 'config', 'user.email', 'test@example.invalid');
        writeFileSync(join(source.rootPath, 'README.md'), 'Existing project\n');
        git(source.rootPath, 'add', '.');
        git(source.rootPath, 'commit', '-m', 'Initial');
      }
      runtime.setWorkspaceMode('p', { mode });
      runtime.agentControl.create({
        id: 'worker',
        name: 'Worker only',
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
      expect((await call('collaboration_list_projects', {}, 'a'.repeat(64))).statusCode).toBe(401);
      expect(
        (await call('collaboration_list_projects', {}))
          .json()
          .result.projects.map((p: { id: string }) => p.id),
      ).toEqual(['p']);
      expect((await call('collaboration_list_tasks', { projectId: 'private' })).statusCode).toBe(
        403,
      );
      const input = {
        projectId: 'p',
        agentId: 'worker',
        objective: 'Create first file',
        idempotencyKey: 'round-1',
      };
      const first = await call('collaboration_submit_task', input);
      expect(first.statusCode, first.body).toBe(200);
      const firstId = first.json().result.task.id;
      expect((await call('collaboration_submit_task', input)).json().result).toMatchObject({
        task: { id: firstId },
        reused: true,
      });
      expect(
        (await call('collaboration_submit_task', { ...input, objective: 'Different' })).statusCode,
      ).toBe(409);
      await expect.poll(() => runtime.getTask(firstId).state, { timeout: 10000 }).toBe('completed');
      expect(storage.repositories.assignments.list()[0]?.role?.name).toBe('Collaborator');
      expect(existsSync(join(source.rootPath, 'first.txt'))).toBe(false);
      const firstAssignment = storage.repositories.assignments.list()[0]!;
      const firstWorkspace = storage.repositories.workspaces.get(
        storage.repositories.assignmentWorkspaces.get(firstAssignment.id)!.workspaceId,
      )!;
      const progress = (
        await call('collaboration_get_task', { taskId: firstId, limit: 100 })
      ).json().result;
      expect(progress.events.some((e: { type: string }) => e.type === 'agent.progress')).toBe(true);
      expect(progress.artifacts.length).toBeGreaterThan(0);
      const artifact = progress.artifacts.find((a: { mimeType: string }) =>
        a.mimeType.startsWith('text/'),
      );
      const excerpt = (
        await call('collaboration_get_artifact', { artifactId: artifact.id, maxChars: 8 })
      ).json().result;
      expect(excerpt.text.length).toBeLessThanOrEqual(8);
      expect(JSON.stringify(excerpt)).not.toContain('storageKey');
      await runtime.close();
      await app.close();
      storage.close();
      storage = openSqliteStorage({ filename });
      runtime = createControlPlaneRuntime(options());
      app = build();
      runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
      const followup = {
        taskId: firstId,
        content: 'Add a second file while keeping first',
        idempotencyKey: 'round-2',
      };
      const response = await call('collaboration_continue_task', followup);
      expect(response.statusCode, response.body).toBe(200);
      const secondId = response.json().result.task.id;
      expect((await call('collaboration_continue_task', followup)).json().result.task.id).toBe(
        secondId,
      );
      await expect
        .poll(() => runtime.getTask(secondId).state, { timeout: 10000 })
        .toBe('completed');
      const binding = storage.repositories.assignmentWorkspaces
        .list()
        .find((b) => b.taskId === secondId)!;
      const work = storage.repositories.workspaces.get(binding.workspaceId)!;
      expect(readFileSync(join(work.rootPath, 'first.txt'), 'utf8')).toBe('first round\n');
      expect(readFileSync(join(work.rootPath, 'second.txt'), 'utf8')).toBe(
        'continued with first round\n',
      );
      expect(existsSync(join(firstWorkspace.rootPath, 'second.txt'))).toBe(false);
      expect(existsSync(join(source.rootPath, 'second.txt'))).toBe(false);
      expect(
        storage.repositories.events
          .listByProject('p')
          .find((e) => e.taskId === secondId && e.type === 'task.followup.created')?.actor,
      ).toEqual({ type: 'agent', id: 'mcp-client:test' });
      expect(
        (await call('collaboration_get_task', { taskId: firstId })).json().result.nextTaskId,
      ).toBe(secondId);
      if (mode === 'git-worktree') {
        const prepared = await call('collaboration_prepare_review', { taskId: secondId });
        expect(prepared.statusCode, prepared.body).toBe(200);
        const review = prepared.json().result.review;
        expect(review.files.map((f: { path: string }) => f.path)).toEqual([
          'first.txt',
          'second.txt',
        ]);
        expect(
          (await call('collaboration_prepare_review', { taskId: secondId })).json().result.review
            .id,
        ).toBe(review.id);
        const url = `/api/tasks/${secondId}/workspace-reviews/${review.id}`;
        const payload = {
          confirmedTargetBranch: review.targetBranch,
          confirmedMergeCommit: review.mergeCommit,
        };
        expect(
          (await app.inject({ method: 'POST', url: url + '/merge', payload })).statusCode,
        ).toBe(409);
        expect((await call('collaboration_approve_review', { taskId: secondId })).statusCode).toBe(
          400,
        );
        expect(
          (
            await app.inject({
              method: 'POST',
              url: url + '/decision',
              payload: { state: 'approved' },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await app.inject({ method: 'POST', url: url + '/merge', payload })).statusCode,
        ).toBe(200);
        expect(readFileSync(join(source.rootPath, 'second.txt'), 'utf8')).toBe(
          'continued with first round\n',
        );
      }
      runtime.setProjectPolicy('p', {
        expectedRevision: 0,
        tools: { control_create_task: 'deny' },
        gitMerge: 'ask',
        gitPush: 'deny',
        requireEnforcedExecution: false,
      });
      expect(
        (await call('collaboration_submit_task', { ...input, idempotencyKey: 'denied' }))
          .statusCode,
      ).toBe(403);
      access.clients[0]!.enabled = false;
      expect((await call('collaboration_get_task', { taskId: firstId })).statusCode).toBe(401);
    } finally {
      await runtime.close();
      await app.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
