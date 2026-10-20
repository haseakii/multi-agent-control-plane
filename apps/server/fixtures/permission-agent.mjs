import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

acp
  .agent({ name: 'permission-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'permission-session' }))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const expected = ctx.params.prompt[0].text;
    const result = await ctx.client.request(acp.methods.client.session.requestPermission, {
      sessionId: ctx.params.sessionId,
      toolCall: {
        toolCallId: 'permission-tool',
        title: 'Read the test workspace',
        kind: 'read',
        status: 'pending',
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    assert.deepEqual(
      result.outcome,
      expected === 'approve'
        ? { outcome: 'selected', optionId: 'allow-once' }
        : { outcome: 'cancelled' },
    );
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text:
            expected === 'approve'
              ? 'Permission approved once.'
              : 'Permission rejected; no operation performed.',
        },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
