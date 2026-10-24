import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

let cwd;
let turn = 0;
acp
  .agent({ name: 'permission-boundary-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: { loadSession: true },
    ...(process.argv.includes('--native-edit') ? {agentInfo:{name:'antigravity-acp',version:'1.4.1'}} : {}),
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    cwd = ctx.params.cwd;
    return { sessionId: 'fixture-session' };
  })
  .onRequest(acp.methods.agent.session.load, (ctx) => {
    cwd = ctx.params.cwd;
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    // The objective precedes the durable execution context in the host prompt.
    const mode = ctx.params.prompt[0].text.split('\n')[0];
    const toolCallId = 'fixture-tool-' + ++turn;
    const call = {
      toolCallId,
      title: 'Read synthetic fixture file',
      kind: 'read',
      status: 'pending',
      rawInput: {
        tool: 'workspace.read',
        action: 'read',
        path: 'synthetic.txt',
        description: mode === 'large' ? '字'.repeat(20000) : 'Local synthetic fixture only',
      },
      locations: [{ path: 'synthetic.txt' }],
    };
    if(process.argv.includes('--native-edit')) {
      const target=join(cwd,'auto-policy.txt');
      call.title='Edit synthetic file';call.kind='edit';
      call.rawInput={TargetFile:target,TargetContent:'before',ReplacementContent:'after',StartLine:1,EndLine:1,AllowMultiple:false,Description:'Small fixture edit',Instruction:'Replace before'};
      call.content=[{type:'diff',path:target,oldText:'before',newText:'after',_meta:{kind:'modify'}}];
      call.locations=[{path:target}];
      if (mode === 'native-large') {
        call.rawInput.TargetContent = 'const before = 1;\n'.repeat(1500);
        call.rawInput.ReplacementContent = 'const after = 2;\n'.repeat(1600);
        call.content[0].oldText = call.rawInput.TargetContent;
        call.content[0].newText = call.rawInput.ReplacementContent;
      }
      writeFileSync(target,'before');
    }
    if (mode === 'sdk-filter') {
      call.title = 42;
      call.extra = { password: 'CANARY_DROPPED' };
    }
    if (mode === 'auth-basic')
      call.rawInput.description =
        'Authorization: Basic ' +
        Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64');
    if (mode === 'uppercase-url')
      call.rawInput.description =
        'HTTPS://synthetic-user:ONLY_SYNTHETIC_URL_CANARY@example.test/file?key=ONLY_SYNTHETIC_QUERY_CANARY';
    if (mode === 'partial')
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'tool_call', ...call },
      });
    if (mode === 'exit')
      setInterval(() => {
        if (existsSync(join(cwd, 'exit-now'))) process.exit(0);
      }, 10).unref();
    const request = ctx.client.request(acp.methods.client.session.requestPermission, {
      sessionId: mode === 'wrong-session' ? 'unrelated-session' : ctx.params.sessionId,
      toolCall: ['partial', 'missing'].includes(mode) ? { toolCallId } : call,
      options:
        mode === 'only-always'
          ? [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }]
          : [
              { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
              {
                optionId: mode === 'duplicate-options' ? 'once' : 'always',
                name: 'Always allow',
                kind: 'allow_always',
              },
              { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
            ],
    });
    const concurrent =
      mode === 'concurrent'
        ? ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: { ...call, toolCallId: 'other-in-flight-tool' },
            options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
          })
        : undefined;
    const response = await request;
    if(process.argv.includes('--native-edit') && response.outcome.outcome==='selected')
      writeFileSync(join(cwd,'auto-policy.txt'),call.rawInput.ReplacementContent);
    if (concurrent)
      appendFileSync(
        join(cwd, 'permission-ack.jsonl'),
        JSON.stringify({ turn, concurrent: true, outcome: (await concurrent).outcome }) + '\n',
      );
    appendFileSync(
      join(cwd, 'permission-ack.jsonl'),
      JSON.stringify({ turn, outcome: response.outcome }) + '\n',
    );
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(response.outcome) },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
