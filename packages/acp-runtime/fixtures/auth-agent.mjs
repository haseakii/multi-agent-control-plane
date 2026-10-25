import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const configOptions = (model = 'small') => [
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
];

acp
  .agent({ name: 'auth-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
    authMethods: [{ id: 'agent-login', name: 'Agent login' }],
  }))
  .onRequest(acp.methods.agent.authenticate, () =>
    process.argv.includes('--hang-auth') ? new Promise(() => {}) : {},
  )
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    if (ctx.params.mcpServers.length) throw new Error('Discovery must not expose MCP servers.');
    const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
      sessionId: 'settings',
      toolCall: { toolCallId: 'not-a-prompt', title: 'Discovery permission' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
    if (permission.outcome.outcome !== 'cancelled')
      throw new Error('Discovery permission granted.');
    return { sessionId: 'settings', configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => ({
    configOptions: configOptions(ctx.params.value),
  }))
  .onRequest(acp.methods.agent.session.prompt, () => {
    throw new Error('No discovery prompts.');
  })
  .connect(stream);
