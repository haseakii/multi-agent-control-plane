import { AcpRuntimeConnection } from './runtime.js';
import { DenyByDefaultPermissionBroker } from './permission.js';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AgentDefinitionSchema } from '@control-plane/core';
import { LocalRunner } from '@control-plane/runner';
import { ProcessAgentRuntimeControl } from './process-control.js';
it('exposes a real initialize-only negotiation, with unknown login and withheld extension values', async () => {
  const control = new ProcessAgentRuntimeControl(
    new LocalRunner({ id: 'negotiation-probe', defaultStopGracePeriodMs: 100 }),
    { probeTimeoutMs: 5000 },
  );
  const definition = AgentDefinitionSchema.parse({
    id: 'negotiation-fixture',
    name: 'Negotiation fixture',
    enabled: false,
    runtime: {
      type: 'acp-stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/negotiation-agent.mjs', import.meta.url))],
    },
    capabilities: [],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
  const value = await control.probe(definition);
  expect(value.readiness.auth).toBe('unknown');
  expect(value.readiness.observedAt).toMatch(/^\d{4}-/);
  expect(value.negotiation).toMatchObject({
    protocolVersion: 1,
    agentInfo: { name: 'negotiation-only-fixture', version: '0.1.0' },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
    },
  });
  expect(value.negotiation?.authMethods).toEqual([
    { id: 'fixture-login', name: 'Explicit fixture login' },
  ]);
  expect(JSON.stringify(value.negotiation)).not.toContain('synthetic-extension-not-public');
  expect(value.negotiation?.agentCapabilities._meta).toEqual({
    advertisedKeys: ['privateValue'],
    values: '[extension values withheld]',
  });
  // Fixture has no session/new or prompt handlers: successful probe cannot have requested inference.
});

it('bounds hostile extension-key fanout without exposing opaque values', () => {
  const meta = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => ['k' + i + 'x'.repeat(250), 'never-publish-this-value']),
  );
  const sessionCapabilities = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => ['extension' + i, { _meta: meta }]),
  );
  const connection = new AcpRuntimeConnection(
    { closed: new Promise<void>(() => undefined) } as never,
    { protocolVersion: 1, agentCapabilities: { sessionCapabilities } } as never,
    new DenyByDefaultPermissionBroker(),
  );
  const publicText = JSON.stringify(connection.negotiation);
  expect(publicText.length).toBeLessThan(60000);
  expect(publicText).not.toContain('never-publish-this-value');
});

it.each(
  [
    Array.from({ length: 200 }, (_, i) => ({ id: 'id' + i, name: 'x'.repeat(4096) })),
    [{ id: 'x'.repeat(257), name: 'login' }],
  ].map((authMethods) => ({ authMethods })),
)(
  'rejects excessive authentication metadata without truncating callable IDs',
  ({ authMethods }) => {
    expect(
      () =>
        new AcpRuntimeConnection(
          { closed: new Promise<void>(() => undefined) } as never,
          { protocolVersion: 1, authMethods } as never,
          new DenyByDefaultPermissionBroker(),
        ),
    ).toThrow(/authentication metadata.*limit/i);
  },
);
it('bounds the combined public observation in bytes and explicitly marks truncation', () => {
  const c = new AcpRuntimeConnection(
    { closed: new Promise<void>(() => undefined) } as never,
    {
      protocolVersion: 1,
      agentInfo: { name: '界'.repeat(50000) },
      agentCapabilities: {
        _meta: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => ['界'.repeat(250) + i, 'hidden']),
        ),
      },
      authMethods: [{ id: 'exact-id', name: 'login' }],
    } as never,
    new DenyByDefaultPermissionBroker(),
  );
  const text = JSON.stringify({
    readiness: c.readiness,
    negotiation: c.negotiation,
    authMethods: c.authMethods,
  });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
  expect(text).toMatch(/truncated/);
  expect(c.authMethods[0]?.id).toBe('exact-id');
});

it('passes the original maximum-length accepted authentication ID unchanged', async () => {
  const id = '界'.repeat(256);
  let received: unknown;
  const c = new AcpRuntimeConnection(
    {
      closed: new Promise<void>(() => undefined),
      agent: {
        request: async (_method: unknown, params: unknown) => {
          received = params;
          return {};
        },
      },
    } as never,
    { protocolVersion: 1, authMethods: [{ id, name: 'Login' }] } as never,
    new DenyByDefaultPermissionBroker(),
  );
  expect(c.readiness.authMethodIds).toEqual([id]);
  expect(c.authMethods[0]?.id).toBe(id);
  await c.authenticate(id);
  expect(received).toEqual({ methodId: id });
});

it('retains public observation container shapes when the shared budget is exhausted', () => {
  const c = new AcpRuntimeConnection(
    { closed: new Promise<void>(() => undefined) } as never,
    {
      protocolVersion: 1,
      agentCapabilities: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => ['field' + i, 'x'.repeat(2048)]),
      ),
      authMethods: [{ id: 'login', name: 'Login' }],
    } as never,
    new DenyByDefaultPermissionBroker(),
  );
  expect(Array.isArray(c.negotiation.authMethods)).toBe(true);
  expect(typeof c.negotiation.agentCapabilities).toBe('object');
  expect(JSON.stringify(c.negotiation)).toContain('truncated');
  expect(
    Buffer.byteLength(
      JSON.stringify({
        readiness: c.readiness,
        negotiation: c.negotiation,
        authMethods: c.authMethods,
      }),
    ),
  ).toBeLessThan(65536);
});
