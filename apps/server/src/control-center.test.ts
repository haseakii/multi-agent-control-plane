import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { readControlCenterSnapshot, seedDemoState } from './control-center.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('control-center durable demo', () => {
  it('preserves the multi-agent demo history across a storage restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'control-plane-demo-'));
    directories.push(directory);
    const filename = join(directory, 'control-plane.sqlite');

    const first = openSqliteStorage({ filename });
    seedDemoState(first);
    const before = readControlCenterSnapshot(first);
    first.close();

    const second = openSqliteStorage({ filename });
    const after = readControlCenterSnapshot(second);
    second.close();

    expect(before.projects).toHaveLength(1);
    expect(after.agents.map((agent) => agent.definition.id).sort()).toEqual([
      'demo-boss',
      'demo-worker',
    ]);
    expect(after.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);
    expect(after.messages).toHaveLength(2);
    expect(after.artifacts.map((artifact) => artifact.id)).toEqual(['demo-artifact']);
    expect(after.timeline.map((event) => event.type)).toEqual([
      'boss.selected',
      'agents.discovered',
      'task.delegated',
      'worker.completed',
      'boss.completed',
    ]);
  });
});
