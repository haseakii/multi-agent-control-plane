import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { previewFetch } from '../fixtures/preview-fetch.js';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { LocalWorkspacePreviewFiles } from './workspace-preview-files.js';
import { LivePreviewService, listenBrowserPreview } from './live-preview.js';

it('avoids browser-restricted ports and retries a busy port without retaining listeners', async () => {
  const server = new EventEmitter() as EventEmitter & { listen: ReturnType<typeof vi.fn> };
  server.listen = vi.fn((port: number) => {
    queueMicrotask(() =>
      port === 51000
        ? server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))
        : server.emit('listening'),
    );
  });
  const ports = [6000, 10080, 51000, 52000];
  await listenBrowserPreview(server as unknown as Server, () => ports.shift()!);
  expect(server.listen.mock.calls).toEqual([
    [51000, '127.0.0.1'],
    [52000, '127.0.0.1'],
  ]);
  expect(server.listenerCount('error')).toBe(0);
  expect(server.listenerCount('listening')).toBe(0);
});

it('serves actual multi-file pages on an isolated origin, observes stable edits and closes its listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-preview-')),
    service = new LivePreviewService();
  let clock = Date.now();
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  let url = '';
  try {
    await mkdir(join(root, 'js'));
    await writeFile(
      join(root, 'index.html'),
      '<link rel="stylesheet" href="/style.css"><script type="module" src="./js/app.js"></script>',
    );
    await writeFile(join(root, 'style.css'), 'body{color:blue}');
    await writeFile(
      join(root, 'js', 'app.js'),
      'import {name} from "./data.js"; document.title=name;',
    );
    await writeFile(join(root, 'js', 'data.js'), 'export const name="Real modules";');
    await writeFile(join(root, '.env'), 'PRIVATE=not-public');
    await writeFile(join(root, 'package.json'), '{}');
    const files = new LocalWorkspacePreviewFiles(root, async () => {});
    const first = await service.start({
      taskId: 'task',
      workspaceId: 'workspace',
      rootPath: root,
      parentOrigin: 'http://127.0.0.1:8057',
      files,
    });
    url = first.url;
    expect(first.state).toBe('ready');
    expect(new URL(url).port).not.toBe('8057');
    expect(Number(new URL(url).port)).toBeGreaterThanOrEqual(49152);
    expect(first.fileCount).toBe(4);
    const document = await service.document('task', first.id, 'workspace');
    expect(document.html).toContain(`<base href="${first.url}">`);
    expect(document.html).toContain("default-src 'none'");
    expect(document.revision).toBe(first.revision);
    const module = await previewFetch(url + 'js/data.js', { headers: { origin: 'null' } });
    expect(module.headers.get('access-control-allow-origin')).toBe('null');
    expect((await previewFetch(url, { headers: { host: 'localhost' } })).status).toBe(403);
    const html = await previewFetch(url);
    expect(html.headers.get('cache-control')).toBe('no-store');
    expect(html.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await html.text()).toContain('control-plane-preview-error');
    const reads = vi.spyOn(files, 'read');
    expect(await (await previewFetch(url)).text()).toContain('control-plane-preview-ready');
    expect(reads).not.toHaveBeenCalled();
    expect(await (await previewFetch(url + 'style.css')).text()).toBe('body{color:blue}');
    expect(await (await previewFetch(url + 'js/data.js')).text()).toContain('Real modules');
    for (const path of ['.env', 'package.json', '%2e%2e%2fsecret.html', 'api/control-center'])
      expect((await previewFetch(url + path)).status).toBe(404);
    expect(
      (await previewFetch(url, { headers: { origin: 'https://foreign.example' } })).status,
    ).toBe(403);
    await writeFile(join(root, 'style.css'), 'body{color:purple}');
    expect((await service.status('task', first.id, 'workspace')).revision).toBe(first.revision);
    clock += 400;
    const changed = await service.status('task', first.id, 'workspace');
    expect(changed.revision).not.toBe(first.revision);
    expect(await (await previewFetch(url + 'style.css')).text()).toBe('body{color:purple}');
    await writeFile(join(root, 'index.html'), '<h1>Saved document revision</h1>');
    await service.status('task', first.id, 'workspace');
    clock += 400;
    await service.status('task', first.id, 'workspace');
    expect(await (await previewFetch(url)).text()).toContain('Saved document revision');
    await expect(service.status('another-task', first.id, 'workspace')).rejects.toThrow();
  } finally {
    now.mockRestore();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
  await expect(previewFetch(url)).rejects.toThrow();
});

it('waits for a newly created page and keeps build assets rooted together, rejecting linked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-preview-')),
    outside = await mkdtemp(join(tmpdir(), 'preview-outside-'));
  const service = new LivePreviewService();
  let clock = Date.now();
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    const files = new LocalWorkspacePreviewFiles(root, async () => {});
    const first = await service.start({
      taskId: 'task',
      workspaceId: 'workspace',
      rootPath: root,
      parentOrigin: 'http://127.0.0.1:8057',
      files,
    });
    expect(first.state).toBe('waiting');
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'index.html'), '<h1>Build output</h1>');
    await writeFile(join(root, 'dist', 'style.css'), 'h1{color:green}');
    await writeFile(join(outside, 'secret.js'), 'private');
    await symlink(outside, join(root, 'dist', 'linked'), 'junction');
    await service.status('task', first.id, 'workspace');
    clock += 400;
    const ready = await service.status('task', first.id, 'workspace');
    expect(ready.state).toBe('ready');
    expect(ready.entry).toBe('dist/index.html');
    expect(await (await previewFetch(first.url)).text()).toContain('Build output');
    expect(await (await previewFetch(first.url + 'style.css')).text()).toContain('green');
    expect((await previewFetch(first.url + 'linked/secret.js')).status).toBe(404);
    await expect(files.read('../secret.js')).rejects.toThrow();
  } finally {
    now.mockRestore();
    await service.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
