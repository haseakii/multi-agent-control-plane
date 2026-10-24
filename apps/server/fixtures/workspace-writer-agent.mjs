import assert from 'node:assert/strict';
import { appendFile, access, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

acp.agent({name:'workspace-writer-fixture'})
  .onRequest(acp.methods.agent.initialize, ctx => ({protocolVersion:ctx.params.protocolVersion, agentCapabilities:{}}))
  .onRequest(acp.methods.agent.session.new, ctx => {
    assert.equal(resolve(ctx.params.cwd), process.cwd());
    return {sessionId:'workspace-session'};
  })
  .onRequest(acp.methods.agent.session.prompt, async ctx => {
    const objective = ctx.params.prompt[0].text.split('\n')[0];
    await writeFile('shared.txt', objective);
    await appendFile('attempts.txt', objective + '\n');
    for (;;) { try { await access(join(process.cwd(), 'release')); break; } catch { await delay(20); } }
    await ctx.client.notify(acp.methods.client.session.update, {sessionId:ctx.params.sessionId,
      update:{sessionUpdate:'agent_message_chunk', content:{type:'text', text:'Completed in ' + process.cwd()}}});
    return {stopReason:'end_turn'};
  }).connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
