import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AcpClientRuntime, AcpRuntimeConnection } from './runtime.js';
import { permissionWireShape } from './permission-review.js';
import type { AgentEvent, PermissionDecision } from './types.js';

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
  it('reports a real transport closure as retryable failure, never completion', async () => {
    let cutTransport!: () => void;
    const outbound = new TransformStream<acp.AnyMessage>({
      start(controller) {
        cutTransport = () => controller.terminate();
      },
    });
    const inbound = new TransformStream<acp.AnyMessage>();
    const streams = {
      client: { writable: inbound.writable, readable: outbound.readable },
      agent: { writable: outbound.writable, readable: inbound.readable },
    };
    const agent = acp
      .agent({ name: 'disconnect-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'disconnect' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: 'disconnect',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial work' },
          },
        });
        cutTransport();
        return { stopReason: 'end_turn' };
      })
      .connect(streams.agent);
    const connection = await new AcpClientRuntime().connect(streams.client);
    const events: AgentEvent[] = [];
    try {
      await connection.newSession({ cwd: '/synthetic' });
      const run = async () => {
        for await (const e of connection.prompt('disconnect', 'work')) events.push(e);
      };
      await expect(run()).rejects.toMatchObject({
        failure: { code: 'ACP_CONNECTION_CLOSED', retryable: true },
      });
      expect(events.some((e) => e.type === 'completed')).toBe(false);
    } finally {
      connection.close();
      agent.close();
    }
  });
  it('treats the confirmed adapter error sentinel as failure even when ACP returns end_turn', async () => {
    const streams = streamPair(),
      events: AgentEvent[] = [];
    const agent = acp
      .agent({ name: 'failure-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        agentInfo: { name: 'antigravity-acp', version: '1.4.1' },
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'failure-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        for (const text of ['Internal error ', 'encountered.'])
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          });
        return { stopReason: 'end_turn' };
      })
      .connect(streams.agent);
    const connection = await new AcpClientRuntime({
      eventSink: (event) => {
        events.push(event);
      },
    }).connect(streams.client);
    try {
      await connection.newSession({ cwd: '/synthetic' });
      const run = async () => {
        for await (const _ of connection.prompt('failure-session', 'fixture')) {
          /* drain */
        }
      };
      await expect(run()).rejects.toMatchObject({
        failure: { code: 'AGENT_UPSTREAM_INTERNAL', retryable: true },
      });
      expect(events.some((e) => e.type === 'completed')).toBe(false);
      expect(events.some((e) => e.type === 'status' && e.updateType === 'turn_failed')).toBe(true);
    } finally {
      connection.close();
      agent.close();
    }
  });
  it('passes negotiated identity and correlated tool fields to the optional permission adapter', async () => {
    const streams = streamPair();
    const agent = acp
      .agent({ name: 'permission-adapter-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        agentInfo: { name: 'synthetic-adapter', version: '1.0.0' },
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'synthetic-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool',
            title: 'Display only',
            name: 'example-read',
            _meta: { fixtureDescriptor: 'example-read' },
            status: 'pending',
            rawInput: { path: 'example.txt' },
          },
        });
        const reply = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'tool' },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
        });
        expect(reply.outcome).toEqual({ outcome: 'cancelled' });
        return { stopReason: 'end_turn' };
      })
      .connect(streams.agent);
    let adapterInput: unknown;
    let review: unknown;
    const connection = await new AcpClientRuntime({
      permissionMetadataValidator: ({ sessionId, agentInfo, metadata }) =>
        sessionId === 'synthetic-session' &&
        agentInfo?.name === 'synthetic-adapter' &&
        JSON.stringify(metadata) === JSON.stringify({ fixtureDescriptor: 'example-read' }),
      permissionResolver: (request) => {
        adapterInput = request;
        return { tool: 'example-read', action: 'read', target: 'example.txt' };
      },
      permissionBroker: {
        decide: async (request) => {
          review = request.review;
          return { outcome: 'cancelled' };
        },
      },
    }).connect(streams.client);
    await connection.newSession({ cwd: '/synthetic' });
    for await (const _event of connection.prompt('synthetic-session', 'synthetic')) {
      /* drain */
    }
    connection.close();
    agent.close();
    expect(adapterInput).toMatchObject({
      sessionId: 'synthetic-session',
      agentInfo: { name: 'synthetic-adapter', version: '1.0.0' },
      toolCall: { name: 'example-read', rawInput: { path: 'example.txt' } },
    });
    expect(review).toMatchObject({
      status: 'complete',
      historyUsed: true,
      provenance: { name: 'history' },
    });
  });
  it('shares redaction with actual SDK tool observations and permission review', async () => {
    const streams = streamPair(),
      events: AgentEvent[] = [];
    const basic = Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64');
    const secrets = [basic, 'ONLY_SYNTHETIC_URL_CANARY', 'ONLY_SYNTHETIC_QUERY_CANARY'];
    const agent = acp
      .agent({ name: 'synthetic-redaction-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        agentCapabilities: {},
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'synthetic-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const tool = {
          toolCallId: 'tool',
          title: 'Synthetic tool',
          kind: 'read' as const,
          status: 'pending' as const,
          rawInput: {
            tool: 'file.read',
            action: 'read',
            path: 'synthetic.txt',
            description: `Authorization: Basic ${basic}`,
            url: 'HTTPS://synthetic-user:ONLY_SYNTHETIC_URL_CANARY@example.test/?key=ONLY_SYNTHETIC_QUERY_CANARY',
          },
        };
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'tool_call', ...tool },
        });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: `Authorization: Basic ${basic}`, priority: 'high', status: 'pending' },
            ],
          },
        });
        const reply = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'tool' },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
        });
        expect(reply.outcome).toEqual({ outcome: 'cancelled' });
        return { stopReason: 'end_turn' };
      })
      .connect(streams.agent);
    let review: unknown;
    const connection = await new AcpClientRuntime({
      eventSink: (event) => {
        events.push(event);
      },
      permissionBroker: {
        decide: async (request) => {
          review = request.review;
          return { outcome: 'cancelled' };
        },
      },
    }).connect(streams.client);
    await connection.newSession({ cwd: '/synthetic' });
    for await (const _event of connection.prompt('synthetic-session', 'synthetic')) {
      /* drain actual SDK */
    }
    connection.close();
    agent.close();
    expect(events.some((event) => event.type === 'tool')).toBe(true);
    expect(events.some((event) => event.type === 'status' && event.updateType === 'plan')).toBe(
      true,
    );
    expect(secrets.some((secret) => JSON.stringify({ events, review }).includes(secret))).toBe(
      false,
    );
    expect(review).toMatchObject({
      status: 'invalid',
      historyUsed: true,
      reasons: expect.arrayContaining(['sensitive_redacted']),
    });
  });
  it('cancels a late permission result after prompt failure while the generator consumer is paused', async () => {
    let failPrompt!: (reason: Error) => void,
      finishPermission!: (decision: PermissionDecision) => void;
    const request = new Promise<acp.PromptResponse>((_, reject) => {
      failPrompt = reject;
    });
    const decision = new Promise<PermissionDecision>((resolve) => {
      finishPermission = resolve;
    });
    let permissionSignal: AbortSignal | undefined;
    const runtime = new AcpRuntimeConnection(
      {
        closed: new Promise<void>(() => undefined),
        signal: new AbortController().signal,
        agent: { request: () => request },
        close: () => undefined,
      } as never,
      { protocolVersion: 1 },
      {
        decide: async (params) => {
          permissionSignal = params.signal;
          return decision;
        },
      },
    );
    const iterator = runtime.prompt('synthetic-session', 'synthetic prompt');
    const first = iterator.next();
    const params = {
      sessionId: 'synthetic-session',
      toolCall: {
        toolCallId: 'tool',
        rawInput: { tool: 'file.read', action: 'read', path: 'synthetic.txt' },
      },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' as const }],
    };
    const reply = runtime.handlePermissionRequest(params, permissionWireShape(params.toolCall));
    expect((await first).value?.type).toBe('permission_request');
    failPrompt(new Error('Synthetic prompt failure'));
    await request.catch(() => undefined);
    const abortedBeforeDecision = permissionSignal?.aborted;
    finishPermission({ outcome: 'selected', optionId: 'once' });
    const result = await reply;
    await expect(iterator.next()).rejects.toThrow('Synthetic prompt failure');
    runtime.close();
    expect(abortedBeforeDecision).toBe(true);
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });
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
          usage: {
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 10,
            cachedReadTokens: 7,
            cachedWriteTokens: null,
          },
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
    expect(session).toEqual({
      sessionId: 'session-1',
      settings: { source: 'unavailable', options: [] },
    });

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
      usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: 7 },
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
