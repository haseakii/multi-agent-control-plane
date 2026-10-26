import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A deterministic ACP agent, not an in-process test double. Its only view of the
// worker is the logical identity returned by Fleet discovery.
const sessions = new Map();

async function attach(params, sessionId) {
  assert.equal(params.mcpServers.length, 1, 'Boss requires a session-attached Fleet bridge');
  const config = params.mcpServers[0];
  assert.equal(config.name, 'control-plane-fleet');
  const client = new Client({ name: 'v0-boss-fixture', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: Object.fromEntries(config.env.map(({ name, value }) => [name, value])),
    stderr: 'inherit',
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(({ name }) => name === 'control_delegate_task'));
  assert.ok(!tools.some(({ name }) => name === 'control_publish_artifact'));
  sessions.set(sessionId, client);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  const content = result.content.find((part) => part.type === 'text');
  assert.ok(content, 'Fleet tool returned no text');
  return JSON.parse(content.text);
}

acp
  .agent({ name: 'v0-boss-fixture' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: { loadSession: true },
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    const sessionId = 'boss-session';
    const client = await attach(ctx.params, sessionId);
    // The proxy can initialize before ACP has returned a session ID, but the
    // parent must reject tool execution until FleetBossSessionAttachment binds it.
    const pending = await client.callTool({
      name: 'control_get_task',
      arguments: { taskId: 'root-task' },
    });
    assert.equal(pending.isError, true);
    assert.match(pending.content[0].text, /not bound to an ACP session/);
    await writeFile(join(ctx.params.cwd, 'boss-session.json'), JSON.stringify({ sessionId }));
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const saved = JSON.parse(await readFile(join(ctx.params.cwd, 'boss-session.json'), 'utf8'));
    assert.equal(ctx.params.sessionId, saved.sessionId);
    await attach(ctx.params, saved.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const client = sessions.get(ctx.params.sessionId);
    assert.ok(client, 'No Fleet session attached');
    const input = JSON.parse(ctx.params.prompt.map((part) => part.text ?? '').join(''));
    let response;
    if (input.action === 'delegate') {
      const candidates = await call(client, 'control_discover_agents', { exact: ['code.review'] });
      assert.equal(candidates.length, 1);
      const task = await call(client, 'control_create_task', {
        title: 'Review control-plane boundaries',
        objective: 'Review the boundaries and return a durable result.',
        parentTaskId: input.rootTaskId,
      });
      const delegated = await call(client, 'control_delegate_task', {
        taskId: task.id,
        agentId: candidates[0].agentId,
        role: { name: 'boundary reviewer' },
      });
      response = { delegatedTaskId: task.id, workerAgentId: delegated.assignment.agentId };
    } else {
      assert.equal(input.action, 'complete');
      const { message } = input;
      const task = await call(client, 'control_get_task', { taskId: message.taskId });
      assert.equal(task.state, 'completed');
      assert.deepEqual(task.resultArtifactRefs, message.artifactRefs);
      const artifact = await call(client, 'control_get_artifact', {
        artifactId: message.artifactRefs[0],
      });
      assert.equal(artifact.producerAgentId, message.fromAgentId);
      response = {
        final: `Final answer incorporates the durable worker result: ${message.content}`,
        artifactId: artifact.id,
        messageId: message.id,
      };
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(response) },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
