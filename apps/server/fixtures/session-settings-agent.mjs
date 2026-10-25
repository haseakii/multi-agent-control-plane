import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const trace = process.argv[2];
const rejectLarge = process.argv.includes('--reject-large');
const malformedSettings = process.argv.includes('--malformed-settings');
const idleUpdate = process.argv.includes('--idle-update');
let cwd;
let model = 'small';
let thought = 'low';
const record = (type, data = {}) =>
  appendFileSync(trace, JSON.stringify({ type, model, thought, ...data }) + '\n');
const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'small', name: 'Small' },
      { value: 'large', name: 'Large' },
    ],
  },
  {
    id: 'reasoning',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: thought,
    options:
      model === 'large'
        ? [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ]
        : [{ value: 'low', name: 'Low' }],
  },
];

acp
  .agent({ name: 'synthetic-settings-execution-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    cwd = ctx.params.cwd;
    record('new', { cwd });
    const advertised = configOptions();
    if (malformedSettings) advertised[0].currentValue = 'not-advertised';
    return { sessionId: 'settings-fixture', configOptions: advertised };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    record('set', { configId: ctx.params.configId, value: ctx.params.value });
    if (ctx.params.configId === 'model') {
      if (rejectLarge && ctx.params.value === 'large')
        throw new Error('Bearer do-not-persist-provider-secret');
      model = ctx.params.value;
      thought = 'low';
    } else if (ctx.params.configId === 'reasoning') {
      if (!configOptions()[1].options.some((option) => option.value === ctx.params.value))
        throw new Error('Dependent thought value was not refreshed.');
      thought = ctx.params.value;
    } else throw new Error('Unexpected setting.');
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const text = ctx.params.prompt.map((part) => part.text ?? '').join('\n');
    const followup = text.includes('Continue the user conversation.');
    record('prompt', { followup, text });
    if (followup) {
      if (!existsSync(join(cwd, 'first.txt')))
        throw new Error('Earlier workspace edits were lost.');
      writeFileSync(
        join(cwd, 'second.txt'),
        readFileSync(join(cwd, 'first.txt'), 'utf8') + '\nfollowup',
      );
    } else writeFileSync(join(cwd, 'first.txt'), `${model}/${thought}`);
    if (!followup && text.includes('CONFIRM_NEXT_THOUGHT')) {
      thought = 'low';
      record('update');
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
      });
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Settings fixture completed; preserve this result in followup context.',
        },
      },
    });
    if (idleUpdate) {
      // The test releases this signal only after the host has left its prompt
      // iterator, while report publication keeps the live connection attached.
      const timer = setInterval(() => {
        if (!existsSync(trace + '.notify')) return;
        clearInterval(timer);
        thought = 'low';
        record('idle-update');
        void ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
        });
      }, 10);
      timer.unref();
    }
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
