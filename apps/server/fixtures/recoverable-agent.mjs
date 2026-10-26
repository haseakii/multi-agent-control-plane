// Deterministic ACP fault fixture; never registered in the user's daily data.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
acp
  .agent({ name: 'recoverable-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentInfo: { name: 'antigravity-acp', version: '1.4.1' },
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'recoverable' }))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt.map((p) => p.text ?? '').join('\n');
    let text;
    if (!existsSync('partial.txt')) {
      writeFileSync('partial.txt', 'unmerged code survives\n');
      text = 'Internal error encountered.';
    } else {
      if (readFileSync('partial.txt', 'utf8') !== 'unmerged code survives\n')
        throw Error('Workspace lost');
      if (
        !prompt.includes('Agent 上游服务返回内部错误') ||
        !prompt.includes('Internal error encountered.')
      )
        throw Error('Failure context lost');
      writeFileSync('recovered.txt', 'continued without resetting existing files\n');
      text = 'Recovered with prior edits and failure context.';
    }
    for (const part of [text.slice(0, 9), text.slice(9)])
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } },
      });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
