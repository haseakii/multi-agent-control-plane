import { expect, it, vi } from 'vitest';
import { AgentControlError } from './agent-control.js';
import { warmStartupAgents } from './startup-agents.js';
const ready = { readiness: { auth: 'ready' } } as Awaited<
  ReturnType<import('./agent-control.js').AgentControlService['warmAuthentication']>
>;
it('keeps other members progressing and retries only one transient authentication failure', async () => {
  const calls: string[] = [];
  const warmAuthentication = vi.fn(async (id: string) => {
    calls.push(id);
    if (id === 'slow' && calls.filter((x) => x === id).length === 1)
      throw new AgentControlError(502, 'transient', 'authentication_unavailable');
    return ready;
  });
  const report = vi.fn();
  await warmStartupAgents(
    [
      { agentId: 'slow', authMethodId: 'login' },
      { agentId: 'fast', authMethodId: 'login' },
    ],
    { warmAuthentication },
    { signal: new AbortController().signal, report, wait: async () => {} },
  );
  expect(calls).toEqual(['slow', 'fast', 'slow']);
  expect(report).toHaveBeenCalledWith('slow', 'retrying');
  expect(report).toHaveBeenCalledWith('slow', 'ready');
  expect(report).toHaveBeenCalledWith('fast', 'ready');
});
it('does not retry a rejected login or continue after shutdown', async () => {
  const warmAuthentication = vi.fn(async () => {
    throw new AgentControlError(502, 'login rejected', 'authentication_failed');
  });
  await warmStartupAgents(
    [{ agentId: 'a', authMethodId: 'login' }],
    { warmAuthentication },
    { signal: new AbortController().signal, report: () => {} },
  );
  expect(warmAuthentication).toHaveBeenCalledTimes(1);
  const stop = new AbortController();
  warmAuthentication.mockRejectedValue(
    new AgentControlError(502, 'transient', 'authentication_unavailable'),
  );
  await warmStartupAgents(
    [{ agentId: 'a', authMethodId: 'login' }],
    { warmAuthentication },
    {
      signal: stop.signal,
      report: () => {},
      wait: async () => {
        stop.abort();
      },
    },
  );
  expect(warmAuthentication).toHaveBeenCalledTimes(2);
});
it('bounds repeated transient failure without sending model prompts', async () => {
  const warmAuthentication = vi.fn(async () => {
    throw new AgentControlError(502, 'transient', 'authentication_unavailable');
  });
  const report = vi.fn();
  await warmStartupAgents(
    [{ agentId: 'a', authMethodId: 'login' }],
    { warmAuthentication },
    { signal: new AbortController().signal, report, wait: async () => {} },
  );
  expect(warmAuthentication).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith('a', 'unavailable');
});
