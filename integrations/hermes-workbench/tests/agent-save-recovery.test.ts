import { afterEach, expect, it, vi } from 'vitest';
import { removeAgentWithRecovery, saveAgentWithRecovery } from '../src/agent-save-recovery';
import type { AgentConnectionData, AgentDefinitionData } from '../src/agent-config';
const definition: AgentDefinitionData = {
  id: 'worker',
  name: 'Worker',
  enabled: false,
  runtime: { type: 'acp-stdio', command: 'C:/Tools/agent.exe', args: [] },
  capabilities: [],
  auth: { mode: 'agent-managed' },
  orchestration: { canBeBoss: false },
  controlBridge: { transport: 'none', scopes: [] },
};
const view: AgentConnectionData = {
  definition,
  readiness: { runtime: 'unknown', auth: 'unknown', observedAt: 'now' },
  authMethods: [],
};
afterEach(() => vi.useRealTimers());
it('confirms a lost removal response by absence without sending another delete', async () => {
  const write = vi.fn().mockRejectedValue(Error('response lost'));
  const read = vi.fn().mockResolvedValue([]);
  const checking = vi.fn();
  await removeAgentWithRecovery('worker', write, read, checking);
  expect(write).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  expect(checking).toHaveBeenCalledOnce();
});
it('does not call a removal successful when the member remains or state cannot be read', async () => {
  const failure = Error('delete not confirmed');
  for (const read of [
    async () => [view],
    async () => {
      throw Error('offline');
    },
  ])
    await expect(
      removeAgentWithRecovery(
        'worker',
        async () => {
          throw failure;
        },
        read,
        () => {},
      ),
    ).rejects.toBe(failure);
});
it('bounds both a hanging removal and its state read without replaying the mutation', async () => {
  vi.useFakeTimers();
  const write = vi.fn(() => new Promise(() => {}));
  const read = vi.fn(() => new Promise<AgentConnectionData[]>(() => {}));
  const pending = removeAgentWithRecovery('worker', write, read, () => {}, 100);
  const failed = expect(pending).rejects.toThrow('操作结果暂未确认');
  await vi.advanceTimersByTimeAsync(200);
  await failed;
  expect(write).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('does not perform recovery reads after a confirmed removal', async () => {
  const read = vi.fn();
  await removeAgentWithRecovery(
    'worker',
    async () => ({ removed: true }),
    read,
    () => {},
  );
  expect(read).not.toHaveBeenCalled();
});
it('confirms a lost create or edit reply with one read, without another mutation or connection probe', async () => {
  const write = vi.fn().mockRejectedValue(Error('response lost'));
  const read = vi.fn().mockResolvedValue([view]);
  const checking = vi.fn();
  expect(
    await saveAgentWithRecovery({ ...definition, description: undefined }, write, read, checking),
  ).toEqual(view);
  expect(write).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(checking).toHaveBeenCalledTimes(1);
});
it('does not read again after a successful save', async () => {
  const read = vi.fn(),
    checking = vi.fn();
  expect(await saveAgentWithRecovery(definition, async () => view, read, checking)).toEqual(view);
  expect(read).not.toHaveBeenCalled();
  expect(checking).not.toHaveBeenCalled();
});
it('keeps a conflict when authority, runtime, name or identity differs from the submitted definition', async () => {
  const failure = Error('HTTP 409: conflict');
  for (const changed of [
    { ...definition, id: 'another' },
    { ...definition, name: 'another' },
    { ...definition, enabled: true },
    { ...definition, runtime: { ...definition.runtime, args: ['--other'] } },
    {
      ...definition,
      controlBridge: { transport: 'mcp' as const, scopes: ['artifact.read' as const] },
    },
  ])
    await expect(
      saveAgentWithRecovery(
        definition,
        async () => {
          throw failure;
        },
        async () => [{ ...view, definition: changed }],
        () => {},
      ),
    ).rejects.toBe(failure);
});
it('preserves the original error if confirmation fails or the member does not exist', async () => {
  const failure = Error('write not confirmed');
  for (const read of [
    async () => [],
    async () => {
      throw Error('offline');
    },
  ])
    await expect(
      saveAgentWithRecovery(
        definition,
        async () => {
          throw failure;
        },
        read,
        () => {},
      ),
    ).rejects.toBe(failure);
});
it('bounds a hung write, checks the saved state, and ignores its late response', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const checking = vi.fn();
  const result = saveAgentWithRecovery(
    definition,
    (value) => {
      signal = value;
      return new Promise(() => {});
    },
    async () => [view],
    checking,
    100,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual(view);
  expect(signal.aborted).toBe(true);
  expect(checking).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
