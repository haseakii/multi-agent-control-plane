import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Artifact, Task } from '@control-plane/core';
import { taskResultSummary } from './task-result-summary.js';

it('delivers a complete verified short report with source identity and skips large or unrelated results', async () => {
  const content = Buffer.from('已检查：三个文件，建议保留搜索。');
  const task = {
    id: 't',
    projectId: 'p',
    resultArtifactRefs: ['large', 'foreign', 'short'],
  } as unknown as Task;
  const base = {
    taskId: 't',
    projectId: 'p',
    kind: 'report',
    mimeType: 'text/plain',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  } as Artifact;
  const load = vi.fn(async () => ({ content }));
  const metadata = (id: string) =>
    ({
      ...base,
      id,
      ...(id === 'large' ? { sizeBytes: 4097 } : {}),
      ...(id === 'foreign' ? { projectId: 'other' } : {}),
    }) as Artifact;
  const result = await taskResultSummary(task, { metadata, load });
  expect(load.mock.calls).toHaveLength(1);
  expect(result).toContain(content.toString());
  expect(result).toContain('"artifactId":"short"');
  expect(result).toContain(base.sha256);
});

it('keeps completion deliverable when report integrity or reading fails', async () => {
  const task = { id: 't', projectId: 'p', resultArtifactRefs: ['a'] } as unknown as Task;
  const metadata = () =>
    ({
      taskId: 't',
      projectId: 'p',
      kind: 'report',
      mimeType: 'text/plain',
      sizeBytes: 3,
      sha256: 'invalid',
    }) as Artifact;
  expect(
    await taskResultSummary(task, {
      metadata,
      load: async () => ({ content: Buffer.from('abc') }),
    }),
  ).toBe('');
  expect(
    await taskResultSummary(task, {
      metadata,
      load: async () => {
        throw Error('unavailable');
      },
    }),
  ).toBe('');
});
