import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
let cwd;
acp
  .agent({ name: 'synthetic-input-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: { promptCapabilities: { image: true } },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    cwd = ctx.params.cwd;
    return { sessionId: 'input-fixture', configOptions: [] };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const images = ctx.params.prompt.filter((p) => p.type === 'image');
    const resources = ctx.params.prompt.filter((p) => p.type === 'resource_link');
    if (
      images.length !== 1 ||
      !Buffer.from(images[0].data, 'base64')
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw Error('Native image bytes absent');
    if (
      resources.length !== 1 ||
      readFileSync(fileURLToPath(resources[0].uri), 'utf8') !== 'retain blue-pine-37'
    )
      throw Error('Actual input file absent');
    const text = ctx.params.prompt.map((p) => p.text ?? '').join('\n');
    writeFileSync(
      join(
        cwd,
        text.includes('Continue the user conversation.') ? 'followup-proof.txt' : 'input-proof.txt',
      ),
      'native image + real file + blue-pine-37',
    );
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Read actual image bytes and attachment file.' },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
