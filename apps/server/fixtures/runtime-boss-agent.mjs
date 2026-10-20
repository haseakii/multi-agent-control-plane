import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client;
let taskId;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
}

acp
  .agent({ name: 'production-runtime-boss-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    assert.equal(ctx.params.mcpServers.length, 1);
    const config = ctx.params.mcpServers[0];
    client = new Client({ name: 'production-runtime-boss-fixture', version: '0.1.0' });
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: Object.fromEntries(config.env.map(({ name, value }) => [name, value])),
        stderr: 'inherit',
      }),
    );
    const { tools } = await client.listTools();
    assert.ok(tools.some(({ name }) => name === 'control_delegate_task'));
    assert.ok(!tools.some(({ name }) => name === 'control_send_message'));
    assert.ok(!tools.some(({ name }) => name === 'control_publish_artifact'));
    return { sessionId: 'production-boss-session' };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt.map((part) => part.text ?? '').join('');
    const recoveryMarker = '\nPreviously delivered messages (recovery context, not new work):\n';
    const recovery = prompt.startsWith('Resume the durable task.');
    let output;
    if (!recovery && !prompt.startsWith('Continue with durable worker results.')) {
      assert.equal(prompt, 'Complete the production acceptance goal.');
      const denied = await client.callTool({
        name: 'control_get_task',
        arguments: { taskId: 'unrelated-task' },
      });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /policy denied/);
      const candidates = await call('control_discover_agents', { exact: ['code.review'] });
      assert.equal(candidates.length, 1);
      const task = await call('control_create_task', {
        title: 'Review production boundaries',
        objective: 'Review the boundaries and return a durable result.',
      });
      taskId = task.id;
      await call('control_delegate_task', {
        taskId,
        agentId: candidates[0].agentId,
        role: { name: 'boundary reviewer' },
      });
      output = 'Delegated the review; awaiting the durable worker result.';
    } else {
      if (recovery) assert.ok(prompt.includes(recoveryMarker));
      const messages = JSON.parse(
        recovery
          ? prompt.slice(prompt.indexOf(recoveryMarker) + recoveryMarker.length)
          : prompt.slice(prompt.indexOf('\n') + 1),
      );
      assert.equal(messages.length, 1);
      const [message] = messages;
      if (recovery) taskId = message.taskId;
      assert.equal(message.taskId, taskId);
      const task = await call('control_get_task', { taskId });
      assert.equal(task.state, 'completed');
      assert.deepEqual(task.resultArtifactRefs, message.artifactRefs);
      const artifact = await call('control_get_artifact', {
        artifactId: message.artifactRefs[0],
      });
      assert.equal(artifact.content, 'Worker review: boundaries are consistent. 验收通过 ✓');
      output = `Production final: ${artifact.content}`;
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: output },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
