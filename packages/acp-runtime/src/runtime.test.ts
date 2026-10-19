import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AcpClientRuntime } from './runtime.js';
import type { AgentEvent } from './types.js';

function streamPair(): { client: acp.Stream; agent: acp.Stream } {
  const clientToAgent = new TransformStream<acp.AnyMessage>();
  const agentToClient = new TransformStream<acp.AnyMessage>();

  return {
    client: {
      writable: clientToAgent.writable,
      readable: agentToClient.readable,
    },
    agent: {
      writable: agentToClient.writable,
      readable: clientToAgent.readable,
    },
  };
}

describe('AcpClientRuntime', () => {
  it('initializes, creates/loads a session, streams prompt updates, and cancels', async () => {
    const streams = streamPair();
    const cancelled: string[] = [];
    const loaded: string[] = [];

    const agentApp = acp
      .agent({ name: 'fake-agent' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        agentCapabilities: {
          loadSession: true,
        },
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'session-1',
      }))
      .onRequest(acp.methods.agent.session.load, (ctx) => {
        loaded.push(String(ctx.params.sessionId));
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'hello from fake agent',
            },
          },
        });
        return {
          stopReason: 'end_turn',
        };
      })
      .onNotification(acp.methods.agent.session.cancel, (ctx) => {
        cancelled.push(String(ctx.params.sessionId));
      });

    const agentConnection = agentApp.connect(streams.agent);
    const observed: AgentEvent[] = [];
    const runtime = new AcpClientRuntime({
      eventSink: (event) => {
        observed.push(event);
      },
    });
    const connection = await runtime.connect(streams.client);

    expect(connection.readiness.runtime).toBe('ready');
    expect(connection.readiness.auth).toBe('not_reported');
    expect(connection.capabilities.loadSession).toBe(true);

    const session = await connection.newSession({ cwd: '/workspace' });
    expect(session).toEqual({ sessionId: 'session-1' });

    const promptEvents: AgentEvent[] = [];
    for await (const event of connection.prompt(session.sessionId, 'hello')) {
      promptEvents.push(event);
    }

    expect(promptEvents).toContainEqual({
      type: 'text_delta',
      sessionId: 'session-1',
      text: 'hello from fake agent',
    });
    expect(promptEvents.at(-1)).toEqual({
      type: 'completed',
      sessionId: 'session-1',
      stopReason: 'end_turn',
    });
    expect(observed.some((event) => event.type === 'text_delta')).toBe(true);

    await connection.resumeSession(session.sessionId, { cwd: '/workspace' });
    expect(loaded).toEqual(['session-1']);

    await connection.cancel(session.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toEqual(['session-1']);

    connection.close();
    agentConnection.close();
  });
});
