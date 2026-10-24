import { access, readFile, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

acp.agent({name:'client-worker-fixture'})
  .onRequest(acp.methods.agent.initialize, ctx => ({protocolVersion:ctx.params.protocolVersion,agentCapabilities:{}}))
  .onRequest(acp.methods.agent.session.new, () => ({sessionId:'client-worker'}))
  .onRequest(acp.methods.agent.session.prompt, async ctx => {
    const prompt = ctx.params.prompt.map(p => p.text ?? '').join('\n');
    if (prompt.includes('Continue the user conversation.')) {
      await access('first.txt');
      if ((await readFile('first.txt','utf8')) !== 'first round\n') throw new Error('Previous round lost.');
      await writeFile('second.txt','continued with first round\n');
    } else await writeFile('first.txt','first round\n');
    await ctx.client.notify(acp.methods.client.session.update, {sessionId:ctx.params.sessionId,
      update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Files updated in the task workspace.'}}});
    return {stopReason:'end_turn'};
  }).connect(acp.ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
