import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

it('streams project audit notices and resumes the durable gap after reopen, without payloads or execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-stream-'));
  let storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const makeRuntime = () =>
    createControlPlaneRuntime({
      storage,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
  let runtime = makeRuntime();
  let app = buildServer({ taskControl: runtime });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  async function connect(address: string, cursor?: string) {
    const response = await fetch(address + '/api/projects/p/events/stream', {
      ...(cursor ? { headers: { 'Last-Event-ID': cursor } } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    readers.push(reader);
    let text = '';
    const decoder = new TextDecoder();
    return {
      reader,
      next: async (type: string) => {
        for (;;) {
          while (text.includes('\n\n')) {
            const index = text.indexOf('\n\n'),
              frame = text.slice(0, index);
            text = text.slice(index + 2);
            const lines = frame.split('\n');
            if (lines.includes('event: ' + type))
              return {
                id: lines.find((line) => line.startsWith('id: '))?.slice(4),
                data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)),
              };
          }
          const chunk = await reader.read();
          if (chunk.done) throw Error('Event stream ended before ' + type);
          text += decoder.decode(chunk.value, { stream: true });
        }
      },
    };
  }
  try {
    runtime.createProject({ id: 'p', name: 'Streamed project' });
    runtime.createProject({ id: 'other', name: 'Other project' });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const stream = await connect(address);
    await stream.next('ready');
    runtime.createDraft('other', { objective: 'Must not appear in project p stream' });
    const task = runtime.createDraft('p', {
      title: 'Live draft',
      objective: 'Keep full content in ordinary read APIs',
    });
    const created = await stream.next('control-event');
    expect(created.data).toMatchObject({ projectId: 'p', taskId: task.id, type: 'task.created' });
    expect(Object.keys(created.data).sort()).toEqual([
      'id',
      'occurredAt',
      'projectId',
      'taskId',
      'type',
    ]);
    expect(created.id).toBeTruthy();
    await stream.reader.cancel();
    runtime.taskRecords.update(task.id, {
      version: runtime.taskRecords.inspect(task.id).version,
      title: 'Changed while disconnected',
    });
    await app.close();
    await runtime.close();
    storage.close();
    storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
    runtime = makeRuntime();
    app = buildServer({ taskControl: runtime });
    const restarted = await app.listen({ host: '127.0.0.1', port: 0 });
    const resumed = await connect(restarted, created.id);
    const ready = await resumed.next('ready');
    expect(ready.id).toBeUndefined();
    const updated = await resumed.next('control-event');
    expect(updated.data).toMatchObject({
      projectId: 'p',
      taskId: task.id,
      type: 'task.record_updated',
    });
    expect(updated.id).not.toBe(created.id);
    expect(runtime.getTask(task.id).title).toBe('Changed while disconnected');
    expect(storage.repositories.assignments.list()).toHaveLength(0);
    await app.close(); // Active SSE connections must not hold server shutdown open.
    expect((await resumed.reader.read()).done).toBe(true);
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => {});
    await app.close();
    await runtime.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
