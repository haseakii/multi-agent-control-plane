import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const role = process.argv[2];
const activeReceiver = process.argv[3] === 'active';
let cwd;
let coordinateTaskId;
let client;
let bridgeEnvironment;
let receivedReply = false;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
}

function messagesFrom(prompt, separator) {
  const index = prompt.indexOf(separator);
  assert.ok(index >= 0, `Missing routed message separator for ${role}`);
  return JSON.parse(prompt.slice(index + separator.length));
}

acp
  .agent({ name: `messaging-${role}-fixture` })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    cwd = ctx.params.cwd;
    assert.equal(ctx.params.mcpServers.length, 1);
    const config = ctx.params.mcpServers[0];
    bridgeEnvironment = Object.fromEntries(config.env.map(({ name, value }) => [name, value]));
    client = new Client({ name: `messaging-${role}-fixture`, version: '0.1.0' });
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: bridgeEnvironment,
        stderr: 'inherit',
      }),
    );
    const { tools } = await client.listTools();
    if (role !== 'boss') {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['control_send_message'],
      );
    }
    return { sessionId: `messaging-${role}-session` };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt.map((part) => part.text ?? '').join('');
    const continuing = prompt.startsWith('Continue with durable worker results');
    let output;
    if (role === 'boss') {
      if (!continuing) {
        assert.equal(prompt.split('\n')[0], 'Prove mediated worker-to-worker messaging.');
        if (activeReceiver) {
          const receiver = await call('control_create_task', {
            title: 'Receive an active peer request',
            objective: 'Wait for the peer request.',
          });
          await call('control_delegate_task', { taskId: receiver.id, agentId: 'messenger-b' });
        }
        const [worker] = await call('control_discover_agents', { exact: ['message.coordinate'] });
        assert.ok(worker);
        const task = await call('control_create_task', {
          title: 'Coordinate directly with worker B',
          objective: 'Ask messenger-b for a direct response.',
        });
        coordinateTaskId = task.id;
        await call('control_delegate_task', { taskId: task.id, agentId: worker.agentId });
        output = 'Worker A is coordinating directly.';
      } else {
        const messages = messagesFrom(prompt, '\n');
        const result = messages.find((message) => message.taskId === coordinateTaskId);
        if (result) {
          const artifact = await call('control_get_artifact', {
            artifactId: result.artifactRefs[0],
          });
          assert.equal(
            artifact.content,
            'Worker A received B response through the durable router.',
          );
          receivedReply = true;
        }
        output = receivedReply
          ? 'Messaging final: Worker A received B response through the durable router.'
          : 'Awaiting worker A.';
      }
    } else if (role === 'a') {
      if (!continuing) {
        assert.equal(prompt.split('\n')[0], 'Ask messenger-b for a direct response.');
        // Hidden tools must also be rejected by the authoritative parent boundary,
        // not just omitted from the worker's MCP tool list.
        const escalation = await fetch(
          `${bridgeEnvironment.CONTROL_PLANE_BRIDGE_URL}/internal/fleet/tool`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${bridgeEnvironment.CONTROL_PLANE_BRIDGE_GRANT}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              toolName: 'control_delegate_task',
              input: { taskId: 'unrelated-task', agentId: 'messenger-b' },
            }),
          },
        );
        assert.equal(escalation.status, 403);
        const forgedTask = await client.callTool({
          name: 'control_send_message',
          arguments: {
            targetAgentId: 'messenger-b',
            taskId: 'unrelated-task',
            type: 'request',
            content: 'This must be rejected.',
          },
        });
        assert.equal(forgedTask.isError, true);
        const sent = await call('control_send_message', {
          targetAgentId: 'messenger-b',
          type: 'request',
          content: 'Please acknowledge the mediated request.',
        });
        assert.equal(sent.message.fromAgentId, 'messenger-a');
        if (activeReceiver) await writeFile(process.argv[4] ?? join(cwd, 'request-queued'), '');
        output = 'Awaiting B through the control-plane router.';
      } else {
        const messages = messagesFrom(prompt, '\n');
        if (
          messages.some(
            (message) =>
              message.fromAgentId === 'messenger-b' &&
              message.content === 'B response: acknowledged.',
          )
        ) {
          receivedReply = true;
        }
        output = receivedReply
          ? 'Worker A received B response through the durable router.'
          : 'Awaiting B through the control-plane router.';
      }
    } else {
      assert.equal(role, 'b');
      if (activeReceiver && !continuing && !prompt.includes('\nRouted messages:\n')) {
        // Test-only scheduling barrier: business content still travels via Fleet.
        for (;;) {
          try {
            await access(process.argv[4] ?? join(cwd, 'request-queued'));
            break;
          } catch {
            await delay(10);
          }
        }
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Worker B is ready.' },
          },
        });
        return { stopReason: 'end_turn' };
      }
      const [message] = messagesFrom(prompt, continuing ? '\n' : '\nRouted messages:\n');
      assert.equal(message.fromAgentId, 'messenger-a');
      assert.equal(message.content, 'Please acknowledge the mediated request.');
      const response = await call('control_send_message', {
        targetAgentId: message.fromAgentId,
        type: 'response',
        content: 'B response: acknowledged.',
      });
      assert.equal(response.message.fromAgentId, 'messenger-b');
      output = 'Worker B acknowledged the direct request.';
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
