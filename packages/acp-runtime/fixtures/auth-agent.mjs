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
