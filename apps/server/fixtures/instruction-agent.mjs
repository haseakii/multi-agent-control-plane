import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import * as acp from '@agentclientprotocol/sdk';
let cwd,
  round = 0;
acp
  .agent({ name: 'synthetic-operator-instruction-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    cwd = ctx.params.cwd;
    return { sessionId: 'synthetic-instruction-session' };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    round++;
    let output;
    if (round === 1) {
      fs.writeFileSync(cwd + '/instruction-round-1.entered', 'Synthetic ACP prompt is waiting');
      while (!fs.existsSync(cwd + '/instruction-round-1.release')) await delay(20);
      output = 'Synthetic first round ended.';
    } else {
      const text = ctx.params.prompt.map((part) => part.text ?? '').join('');
      const marker = 'Saved operator task instructions (not approval grants):\n',
        index = text.indexOf(marker);
      assert(index >= 0, 'Missing operator instructions');
      const inputs = JSON.parse(text.slice(index + marker.length));
      assert.equal(inputs[0].actor.type, 'user');
      assert.equal(inputs[0].actor.id, 'local-operator');
      output = 'Synthetic ACP received: ' + inputs.map((x) => x.content).join('; ');
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
