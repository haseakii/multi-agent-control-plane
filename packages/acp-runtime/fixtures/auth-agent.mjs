import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';

if (process.argv.includes('--terminal-login')) {
  const marker = process.argv[process.argv.indexOf('--terminal-login') + 1];
  if (process.argv.includes('--fail-terminal')) process.exit(1);
  writeFileSync(
    marker,
    JSON.stringify({
      args: process.argv.slice(2),
      value: process.env.ACP_TEST_LOGIN,
      tty: !!process.stdin.isTTY,
      pid: process.pid,
    }),
  );
  if (process.argv.includes('--hang-terminal')) {
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  process.exit(0);
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
let authenticated = process.argv.includes('--codebuddy-signed-in');
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
    authMethods: process.argv.includes('--terminal-auth')
      ? ctx.params.clientCapabilities.auth?.terminal
        ? [
            {
              id: 'terminal-login',
              name: 'Terminal login',
              type: 'terminal',
              args: [
                '--terminal-login',
                process.argv[process.argv.indexOf('--terminal-auth') + 1],
                ...(process.argv.includes('--fail-terminal') ? ['--fail-terminal'] : []),
                ...(process.argv.includes('--hang-terminal') ? ['--hang-terminal'] : []),
              ],
              env: { ACP_TEST_LOGIN: 'owned-by-agent' },
            },
          ]
        : []
      : process.argv.includes('--codebuddy-auth')
        ? ['internal', 'external', 'iOA', 'selfhosted'].map((id) => ({ id, name: id }))
        : [{ id: 'agent-login', name: 'Agent login' }],
  }))
  .onRequest(acp.methods.agent.authenticate, () => {
    if (process.argv.includes('--codebuddy-auth'))
      setTimeout(() => {
        authenticated = true;
      }, 30);
    return process.argv.includes('--hang-auth') ? new Promise(() => {}) : {};
  })
  .onRequest('_codebuddy.ai/getUserInfo', { parse: () => ({}) }, () => ({
    userInfo: authenticated
      ? { userId: 'fixture-user', accessToken: 'fixture-private-token' }
      : undefined,
  }))
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
