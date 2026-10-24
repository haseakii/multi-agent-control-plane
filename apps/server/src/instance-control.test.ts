import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createInstanceControl, stopInstance } from './instance-control.js';
it('stops through the private channel only for the same current owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-control-'));
  let close: (() => Promise<void>) | undefined;
  try {
    const lock = join(root, 'instance.lock');
    const owner = { pid: process.pid, token: randomUUID() };
    writeFileSync(lock, JSON.stringify(owner));
    const stop = vi.fn(() => rmSync(lock));
    close = await createInstanceControl(root, stop);
    const control = join(root, 'instance-control.json');
    const saved = readFileSync(control, 'utf8');
    writeFileSync(control, JSON.stringify({ ...JSON.parse(saved), token: randomUUID() }));
    await expect(stopInstance(root)).rejects.toThrow('owner changed');
    expect(stop).not.toHaveBeenCalled();
    writeFileSync(control, saved);
    await stopInstance(root);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  }
});
