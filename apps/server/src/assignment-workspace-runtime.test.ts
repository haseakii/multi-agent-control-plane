import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { previewFetch } from '../fixtures/preview-fetch.js';

it('runs simultaneous assignments in independent Git worktrees and resumes the same directory after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assignment-runtime-'));
  let storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const options = () => ({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  let runtime = createControlPlaneRuntime(options());
  let app = buildServer({ taskControl: runtime, fleetGateway: runtime.fleetGateway });
  try {
    runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
    runtime.createProject({ id: 'p', name: 'Parallel changes' });
    const source = storage.repositories.workspaces.get(
      storage.repositories.projectWorkspaceConfigs.get('p')!.sourceWorkspaceId,
    )!;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: source.rootPath,
        windowsHide: true,
        encoding: 'utf8',
      }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Control Plane Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source.rootPath, 'shared.txt'), 'original');
    git('add', 'shared.txt');
    git('commit', '-m', 'Initial test source');
    const revision = git('rev-parse', 'HEAD');
    runtime.setWorkspaceMode('p', { mode: 'git-worktree' });
    runtime.agentControl.create({
      id: 'writer',
      name: 'Synthetic writer',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/workspace-writer-agent.mjs', import.meta.url))],
      },
      auth: { mode: 'agent-managed' },
      capabilities: [],
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    });
    runtime.agentControl.selectBoss('p', 'writer');
    const a = runtime.submitGoal('p', { objective: 'Change A' }),
      b = runtime.submitGoal('p', { objective: 'Change B' });
    const workspace = (assignmentId: string) => {
      const binding = storage.repositories.assignmentWorkspaces.get(assignmentId);
      return binding ? storage.repositories.workspaces.get(binding.workspaceId) : undefined;
    };
    await expect
      .poll(
        () =>
          [a, b].every((item) => {
            const w = workspace(item.assignment.id);
            return w && existsSync(join(w.rootPath, 'attempts.txt'));
          }),
        { timeout: 10000, interval: 25 },
      )
      .toBe(true);
    const wa = workspace(a.assignment.id)!,
      wb = workspace(b.assignment.id)!;
    expect(wa.rootPath).not.toBe(wb.rootPath);
    expect(wa.baseRevision).toBe(revision);
    expect(wb.baseRevision).toBe(revision);
    expect(readFileSync(join(wa.rootPath, 'shared.txt'), 'utf8')).toBe('Change A');
    expect(readFileSync(join(wb.rootPath, 'shared.txt'), 'utf8')).toBe('Change B');
    expect(readFileSync(join(source.rootPath, 'shared.txt'), 'utf8')).toBe('original');
    writeFileSync(
      join(wa.rootPath, 'index.html'),
      '<link rel="stylesheet" href="style.css"><h1>Running preview</h1>',
    );
    writeFileSync(join(wa.rootPath, 'style.css'), 'h1{color:blue}');
    const live = await app.inject({
      method: 'POST',
      url: `/api/tasks/${a.task.id}/live-preview`,
      payload: {},
    });
    expect(live.statusCode).toBe(200);
    expect(runtime.getTask(a.task.id).state).toBe('running');
    expect(await (await previewFetch(live.json().url + 'style.css')).text()).toBe('h1{color:blue}');
    expect(existsSync(join(source.rootPath, 'index.html'))).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/tasks/${a.task.id}/live-preview`,
          payload: { rootPath: root },
        })
      ).statusCode,
    ).toBe(400);
    writeFileSync(join(wa.rootPath, 'release'), 'finish A');
    await expect
      .poll(() => runtime.getTask(a.task.id).state, { timeout: 5000, interval: 25 })
      .toBe('completed');
    const patchId = runtime
      .getTask(a.task.id)
      .resultArtifactRefs.find((id) => storage.repositories.artifacts.get(id)?.kind === 'diff');
    expect(patchId).toBeDefined();
    expect(new TextDecoder().decode((await runtime.loadArtifact(patchId!)).content)).toContain(
      '+Change A',
    );
    await runtime.close();
    await app.close();
    storage.close();
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
    runtime = createControlPlaneRuntime(options());
    app = buildServer({ taskControl: runtime, fleetGateway: runtime.fleetGateway });
    runtime.setBridgeBaseUrl(await app.listen({ host: '127.0.0.1', port: 0 }));
    runtime.resumeTask(b.task.id);
    await expect
      .poll(
        () =>
          readFileSync(join(wb.rootPath, 'attempts.txt'), 'utf8').split('\n').filter(Boolean)
            .length,
        { timeout: 5000, interval: 25 },
      )
      .toBe(2);
    expect(workspace(b.assignment.id)?.id).toBe(wb.id);
    writeFileSync(join(wb.rootPath, 'release'), 'finish B');
    await expect
      .poll(() => runtime.getTask(b.task.id).state, { timeout: 5000, interval: 25 })
      .toBe('completed');
    expect(storage.repositories.assignmentWorkspaces.list()).toHaveLength(2);
    writeFileSync(join(wa.rootPath, 'index.html'), '<!doctype html><h1>preview A</h1>');
    let preview = await app.inject({
      method: 'POST',
      url: `/api/tasks/${a.task.id}/page-preview`,
      payload: {},
    });
    await expect
      .poll(
        async () => {
          if (preview.statusCode === 409)
            preview = await app.inject({
              method: 'POST',
              url: `/api/tasks/${a.task.id}/page-preview`,
              payload: {},
            });
          return preview.statusCode;
        },
        { timeout: 5000, interval: 25 },
      )
      .toBe(200);
    expect(preview.json()).toMatchObject({
      kind: 'file',
      mimeType: 'text/html',
      taskId: a.task.id,
    });
    const same = await app.inject({
      method: 'POST',
      url: `/api/tasks/${a.task.id}/page-preview`,
      payload: {},
    });
    expect(same.json().id).toBe(preview.json().id);
    expect((await app.inject(`/api/artifacts/${preview.json().id}/content`)).body).toContain(
      'preview A',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/tasks/${a.task.id}/page-preview`,
          payload: { path: '../private' },
        })
      ).statusCode,
    ).toBe(400);

    expect(git('branch', '--show-current')).toBe('main');
    expect(readFileSync(join(source.rootPath, 'shared.txt'), 'utf8')).toBe('original');
  } finally {
    await runtime.close();
    await app.close();
    if (storage.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
