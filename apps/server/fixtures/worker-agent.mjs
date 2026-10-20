import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

acp
  .agent({ name: 'v0-worker-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    assert.deepEqual(ctx.params.mcpServers, [], 'Worker must not receive Boss bridge authority');
    assert.equal(process.env.CONTROL_PLANE_BRIDGE_GRANT, undefined);
    return { sessionId: 'worker-session' };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    assert.match(ctx.params.prompt[0].text, /Review the boundaries/);
    // Include non-ASCII text and multiple updates to exercise real UTF-8 stdio
    // framing rather than relying on a single read containing a whole response.
    for (const text of ['Worker review: ', 'boundaries are consistent. 验收通过 ✓']) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    }
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
