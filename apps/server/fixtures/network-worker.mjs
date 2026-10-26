import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
const trace=process.argv[2];let cwd;
const record=(type,extra={})=>appendFileSync(trace,JSON.stringify({type,...extra})+'\n');
const check=async phase=>{const response=await fetch('http://network-fixture.invalid/'+phase);if(!response.ok)throw Error('Synthetic route unavailable');const value=await response.json();record(phase,{via:value.via});};
acp.agent({name:'synthetic-network-fixture'})
 .onRequest(acp.methods.agent.initialize,async ctx=>{await check('initialize');return {protocolVersion:ctx.params.protocolVersion,agentCapabilities:{}};})
 .onRequest(acp.methods.agent.session.new,async ctx=>{cwd=ctx.params.cwd;await check('new');return {sessionId:'network-fixture',configOptions:[]};})
 .onRequest(acp.methods.agent.session.prompt,async ctx=>{
   await check('prompt');const text=ctx.params.prompt.map(part=>part.text??'').join('\n');
   const retained=join(cwd,'retained.txt');
   if(!existsSync(retained)){writeFileSync(retained,'retained before failure');if(text.includes('INJECT_ONE_FAILURE'))throw Error('Synthetic first-turn failure');}
   if(text.includes('Continue the user conversation.')){if(readFileSync(retained,'utf8')!=='retained before failure')throw Error('Previous edits lost');writeFileSync(join(cwd,'followup.txt'),'context and files retained');record('followup',{previousGoal:text.includes('INJECT_ONE_FAILURE')});}
   await ctx.client.notify(acp.methods.client.session.update,{sessionId:ctx.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Synthetic network task completed with retained context.'}}});
   return {stopReason:'end_turn'};
 }).connect(acp.ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
