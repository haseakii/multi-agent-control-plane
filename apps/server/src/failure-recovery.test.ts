import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { correctRecordedAgentFailure } from './correct-recorded-failure.js';

it.each(['resume', 'continue'] as const)(
  'retains partial edits and failure context through restart and %s',
  async (recovery) => {
    const root = mkdtempSync(join(tmpdir(), 'failure-recovery-')),
      filename = join(root, 'state.sqlite');
    let storage = openSqliteStorage({ filename });
    const makeRuntime = () =>
      createControlPlaneRuntime({
        storage,
        workspaceRoot: join(root, 'workspaces'),
        artifactRoot: join(root, 'artifacts'),
      });
    let runtime = makeRuntime();
    const token = 'e'.repeat(64),
      access = {
        version: 1,
        clients: [
          {
            id: 'test',
            name: 'Test',
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
    const call = async (toolName: string, input: unknown) => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: 'Bearer ' + token },
        payload: { toolName, input },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().result;
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
    const settle = async (taskId: string, state: string) => {
      await expect.poll(() => runtime.getTask(taskId).state, { timeout: 15000 }).toBe(state);
      await expect.poll(() => runtime.taskExecutionActive(taskId), { timeout: 5000 }).toBe(false);
    };
    try {
      runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
      runtime.createProject({ id: 'p', name: 'Failure recovery' });
      const source = storage.repositories.workspaces.get(
        storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId,
      )!;
      git(source.rootPath, 'init', '-b', 'main');
      git(source.rootPath, 'config', 'core.autocrlf', 'false');
      git(source.rootPath, 'config', 'user.name', 'Test');
      git(source.rootPath, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(source.rootPath, 'README.md'), 'Original source\n');
      git(source.rootPath, 'add', '.');
      git(source.rootPath, 'commit', '-m', 'Initial');
      const sourceHead = git(source.rootPath, 'rev-parse', 'HEAD');
      runtime.setWorkspaceMode('p', { mode: 'git-worktree' });
      runtime.setProjectPolicy('p', {
        expectedRevision: 0,
        tools: {},
        gitMerge: 'ask',
        gitPush: 'deny',
        requireEnforcedExecution: false,
        agentPermissions: { workspaceFiles: 'auto', commands: 'ask', outsideWorkspace: 'ask' },
      });
      const policy = storage.repositories.projectPolicies.get('p');
      runtime.agentControl.create({
        id: 'worker',
        name: 'Synthetic recovery fixture',
        enabled: true,
        runtime: {
          type: 'acp-stdio',
          command: process.execPath,
          args: [fileURLToPath(new URL('../fixtures/recoverable-agent.mjs', import.meta.url))],
        },
        auth: { mode: 'agent-managed' },
        capabilities: [],
        orchestration: { canBeBoss: false },
        controlBridge: { transport: 'none', scopes: [] },
      });
      const first = await call('collaboration_submit_task', {
        projectId: 'p',
        agentId: 'worker',
        objective: 'Retain edits and recover',
        idempotencyKey: 'first',
      });
      const taskId = first.task.id;
      await settle(taskId, 'failed');
      const status = await call('collaboration_get_task', { taskId, limit: 100 });
      expect(status.latestAttempt).toMatchObject({
        state: 'failed',
        failure: { code: 'AGENT_UPSTREAM_INTERNAL', retryable: true },
      });
      expect(
        status.events.find((e: { type: string }) => e.type === 'execution.failed').payload,
      ).toMatchObject({ code: 'AGENT_UPSTREAM_INTERNAL' });
      expect(status.task.resultArtifactRefs).toEqual([]);
      const attempt = storage.repositories.executionAttempts
        .list()
        .find((a) => a.taskId === taskId)!;
      const assignment = storage.repositories.assignments.get(attempt.assignmentId)!;
      const binding = storage.repositories.assignmentWorkspaces.get(assignment.id)!;
      const work = storage.repositories.workspaces.get(binding.workspaceId)!;
      expect(readFileSync(join(work.rootPath, 'partial.txt'), 'utf8')).toBe(
        'unmerged code survives\n',
      );
      const artifact = storage.repositories.artifacts
        .list()
        .find((a) => a.taskId === taskId && a.kind === 'log')!;
      const evidence = new TextEncoder().encode('Internal error encountered.');
      // Simulate the old release's false completion, then repair only that record.
      storage.repositories.tasks.upsert({ ...runtime.getTask(taskId), state: 'completed' });
      storage.repositories.assignments.upsert({ ...assignment, state: 'completed' });
      storage.repositories.executionAttempts.upsert({
        ...attempt,
        state: 'completed',
        failure: undefined,
      });
      const correction = {
        taskId,
        attemptId: attempt.id,
        artifactId: artifact.id,
        agentInfo: { name: 'antigravity-acp', version: '1.4.1' },
      };
      expect(() =>
        correctRecordedAgentFailure(
          storage,
          correction,
          new TextEncoder().encode('wrong evidence'),
        ),
      ).toThrow('evidence');
      expect(correctRecordedAgentFailure(storage, correction, evidence).corrected).toBe(true);
      expect(correctRecordedAgentFailure(storage, correction, evidence).corrected).toBe(false);
      expect(
        storage.repositories.events
          .listByProject('p')
          .filter((e) => e.type === 'execution.outcome.corrected'),
      ).toHaveLength(1);
      await runtime.close();
      await app.close();
      storage.close();
      storage = openSqliteStorage({ filename });
      runtime = makeRuntime();
      app = build();
      runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
      expect(runtime.getTask(taskId).state).toBe('failed');
      expect(storage.repositories.executionAttempts.get(attempt.id)?.failure?.code).toBe(
        'AGENT_UPSTREAM_INTERNAL',
      );
      let recoveredId = taskId;
      if (recovery === 'resume') {
        const response = await app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/resume`,
          payload: {},
        });
        expect(response.statusCode, response.body).toBe(202);
      } else {
        recoveredId = (
          await call('collaboration_continue_task', {
            taskId,
            content: 'Continue using existing files',
            idempotencyKey: 'recover',
          })
        ).task.id;
        expect(
          (await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume`, payload: {} }))
            .statusCode,
        ).toBe(409);
        expect((await call('collaboration_get_task', { taskId })).recovery.latestTaskId).toBe(
          recoveredId,
        );
      }
      await settle(recoveredId, 'completed');
      const recoveredBinding = storage.repositories.assignmentWorkspaces
        .list()
        .find((b) => b.taskId === recoveredId)!;
      const recoveredWork = storage.repositories.workspaces.get(recoveredBinding.workspaceId)!;
      if (recovery === 'resume') expect(recoveredWork.id).toBe(work.id);
      expect(readFileSync(join(recoveredWork.rootPath, 'partial.txt'), 'utf8')).toBe(
        'unmerged code survives\n',
      );
      expect(readFileSync(join(recoveredWork.rootPath, 'recovered.txt'), 'utf8')).toContain(
        'without resetting',
      );
      expect(storage.repositories.projectPolicies.get('p')).toEqual(policy);
      expect(git(source.rootPath, 'rev-parse', 'HEAD')).toBe(sourceHead);
      expect(existsSync(join(source.rootPath, 'partial.txt'))).toBe(false);
      const review = (await call('collaboration_prepare_review', { taskId: recoveredId })).review;
      expect(review.files.map((f: { path: string }) => f.path)).toEqual([
        'partial.txt',
        'recovered.txt',
      ]);
      expect(storage.repositories.approvals.get(review.approvalId)?.state).toBe('pending');
      expect(
        (await call('collaboration_get_task', { taskId: recoveredId })).latestAttempt.state,
      ).toBe('completed');
      if (recovery === 'continue') {
        const latest = { ...runtime.getTask(recoveredId), id: 'third-round' };
        storage.repositories.tasks.upsert(latest);
        storage.repositories.events.append({
          id: 'third-round-link',
          projectId: 'p',
          taskId: latest.id,
          type: 'task.followup.created',
          actor: { type: 'user', id: 'test' },
          occurredAt: new Date().toISOString(),
          payload: { sourceTaskId: recoveredId, conversationRootTaskId: taskId },
        });
        expect((await call('collaboration_get_task', { taskId })).recovery.latestTaskId).toBe(
          latest.id,
        );
      }
    } finally {
      await runtime.close();
      await app.close();
      storage.close();
      // Test-owned temporary directory, resolved by mkdtemp above.
      rmSync(root, { recursive: true, force: true });
    }
  },
  45000,
);
