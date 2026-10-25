import { fileURLToPath } from 'node:url';
import { AgentDefinitionSchema } from '@control-plane/core';
import { LocalRunner } from '@control-plane/runner';
import { describe, expect, it, vi } from 'vitest';
import { ProcessAgentRuntimeControl } from './process-control.js';
import type { AcpClientRuntime } from './runtime.js';

const fixturePath = fileURLToPath(new URL('../fixtures/auth-agent.mjs', import.meta.url));

function definition() {
  return AgentDefinitionSchema.parse({
    id: 'fixture-agent',
    name: 'Fixture agent',
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [fixturePath],
      cwd: process.cwd(),
    },
    capabilities: [{ name: 'test.fixture', source: 'configured' }],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
}

describe('ProcessAgentRuntimeControl', () => {
  it('discovers and validates model settings without prompts or MCP access, and releases the process', async () => {
    const runner = new LocalRunner({ defaultStopGracePeriodMs: 100 });
    const stop = vi.spyOn(runner, 'stop');
    const control = new ProcessAgentRuntimeControl(runner, { probeTimeoutMs: 5_000 });
    const snapshot = await control.sessionSettings(definition(), process.cwd(), { model: 'large' });
    expect(snapshot).toMatchObject({
      source: 'config-options',
      options: [{ id: 'model', currentValue: 'large' }],
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runner.status(stop.mock.calls[0]![0]).state).not.toBe('running');
    const inspection = await control.inspectSessionSettings(definition(), process.cwd(), {
      model: 'large',
    });
    expect(inspection.settings).toEqual(snapshot);
    expect(inspection.observation).toMatchObject({
      source: 'acp-session-new',
      sessionIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedAt: expect.any(String),
    });
    expect(inspection.observation).not.toHaveProperty('sessionId');
    expect(inspection.settings).not.toHaveProperty('observation');
    await expect(
      control.sessionSettings(definition(), process.cwd(), { model: 'unavailable' }),
    ).rejects.toMatchObject({ code: 'invalid-value' });
    expect(stop.mock.calls.every(([handle]) => runner.status(handle).state !== 'running')).toBe(
      true,
    );
  });
  it('cancels pending authentication during shutdown and retains connection evidence on timeout', async () => {
    const runner = new LocalRunner({ defaultStopGracePeriodMs: 100 });
    const stop = vi.spyOn(runner, 'stop');
    const agent = definition();
    agent.runtime.args.push('--hang-auth');
    const control = new ProcessAgentRuntimeControl(runner, { authenticationTimeoutMs: 750 });
    const error = await control.authenticate(agent, 'agent-login').catch((error) => error);
    expect(error).toMatchObject({
      reason: 'authentication_unavailable',
      observation: { readiness: { runtime: 'ready' } },
    });
    const cancellable = new ProcessAgentRuntimeControl(runner, { authenticationTimeoutMs: 60_000 });
    const pending = cancellable.authenticate(agent, 'agent-login').catch((error) => error);
    cancellable.close();
    await pending;
    expect(stop.mock.calls.every(([handle]) => runner.status(handle).state !== 'running')).toBe(
      true,
    );
  });
  it('reports an actual missing executable without exposing raw process error details', async () => {
    const control = new ProcessAgentRuntimeControl(new LocalRunner());
    const agent = definition();
    agent.runtime.command = fileURLToPath(
      new URL('../fixtures/missing-acp-program.exe', import.meta.url),
    );
    const error = await control.probe(agent).catch((failure) => failure);
    expect(error).toMatchObject({ name: 'AgentConnectionFailure', reason: 'missing_entry' });
    expect(error.message).toContain('找不到程序或启动目录');
    expect(error.message).not.toContain('missing-acp-program');
  });

  it('reports an initialization failure without forwarding provider output and closes its process', async () => {
    const runner = new LocalRunner({ defaultStopGracePeriodMs: 100 });
    const stop = vi.spyOn(runner, 'stop');
    const control = new ProcessAgentRuntimeControl(runner, {
      runtimeFactory: () =>
        ({
          connect: async () => {
            throw new Error('provider diagnostic Bearer private-value');
          },
        }) as unknown as AcpClientRuntime,
    });
    const error = await control.probe(definition()).catch((failure) => failure);
    expect(error).toMatchObject({ reason: 'initialize_failed' });
    expect(error.message).toContain('ACP 初始化');
    expect(error.message).not.toContain('private-value');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runner.status(stop.mock.calls[0]![0]).state).not.toBe('running');
  });
  it('probes and authenticates a real ACP stdio process through LocalRunner', async () => {
    const runner = new LocalRunner({
      id: 'runtime-control-test',
      defaultStopGracePeriodMs: 100,
    });
    const control = new ProcessAgentRuntimeControl(runner, {
      probeTimeoutMs: 5_000,
      authenticationTimeoutMs: 5_000,
    });
    const spawn = vi.spyOn(runner, 'spawn');

    const probed = await control.probe(definition());
    expect(probed.readiness.runtime).toBe('ready');
    expect(probed.readiness.auth).toBe('unknown');
    expect(probed.authMethods).toEqual([{ id: 'agent-login', name: 'Agent login' }]);

    const authenticated = await control.authenticate(definition(), 'agent-login');
    expect(authenticated.readiness.runtime).toBe('ready');
    expect(authenticated.readiness.auth).toBe('ready');
    expect(spawn.mock.calls.map(([spec]) => spec.agentId)).toEqual([
      'fixture-agent',
      'fixture-agent',
    ]);
  });
});
