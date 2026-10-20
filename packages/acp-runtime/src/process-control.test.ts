import { fileURLToPath } from 'node:url';
import { AgentDefinitionSchema } from '@control-plane/core';
import { LocalRunner } from '@control-plane/runner';
import { describe, expect, it } from 'vitest';
import { ProcessAgentRuntimeControl } from './process-control.js';

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
  it('probes and authenticates a real ACP stdio process through LocalRunner', async () => {
    const runner = new LocalRunner({
      id: 'runtime-control-test',
      defaultStopGracePeriodMs: 100,
    });
    const control = new ProcessAgentRuntimeControl(runner, {
      probeTimeoutMs: 5_000,
      authenticationTimeoutMs: 5_000,
    });

    const probed = await control.probe(definition());
    expect(probed.readiness.runtime).toBe('ready');
    expect(probed.readiness.auth).toBe('unknown');
    expect(probed.authMethods).toEqual([{ id: 'agent-login', name: 'Agent login' }]);

    const authenticated = await control.authenticate(definition(), 'agent-login');
    expect(authenticated.readiness.runtime).toBe('ready');
    expect(authenticated.readiness.auth).toBe('ready');
  });
});
