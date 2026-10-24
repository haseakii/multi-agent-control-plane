import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
acp
  .agent({ name: 'negotiation-only-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentInfo: { name: 'negotiation-only-fixture', version: '0.1.0' },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      _meta: { privateValue: 'synthetic-extension-not-public' },
    },
    authMethods: [{ id: 'fixture-login', name: 'Explicit fixture login' }],
  }))
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
