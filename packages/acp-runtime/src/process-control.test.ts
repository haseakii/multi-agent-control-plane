import { AgentDefinitionSchema } from '@control-plane/core';
import { LocalRunner } from '@control-plane/runner';
import { describe, expect, it } from 'vitest';
import { ProcessAgentRuntimeControl } from './process-control.js';

const fixture = String.raw`
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

acp.agent({ name: 'auth-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
    authMethods: [{ id: 'agent-login', name: 'Agent login' }],
  }))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .connect(stream);
`;

function definition() {
  return AgentDefinitionSchema.parse({
    id: 'fixture-agent',
    name: 'Fixture agent',
    enabled: true,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: ['--input-type=module', '-e', fixture],
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
