import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AcpClientRuntime } from './runtime.js';
import { sessionSettingsFromResponse } from './session-settings.js';
import type { AgentEvent } from './types.js';

function streamPair(): { client: acp.Stream; agent: acp.Stream } {
  const outgoing = new TransformStream<acp.AnyMessage>();
  const incoming = new TransformStream<acp.AnyMessage>();
  return {
    client: { writable: outgoing.writable, readable: incoming.readable },
    agent: { writable: incoming.writable, readable: outgoing.readable },
  };
}

function modelOptions(model = 'small', thought = 'low'): acp.SessionConfigOption[] {
  return [
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
        model === 'small'
          ? [{ value: 'low', name: 'Low' }]
          : [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
    },
    {
      id: 'context_tokens',
      name: 'Context tokens',
      category: 'model_config',
      type: 'select',
      currentValue: '32k',
      options: [{ value: '32k', name: '32,000' }],
    },
    {
      id: 'mode',
      name: 'Permissions',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'yolo', name: 'Yolo' },
      ],
    },
  ];
}

const legacyModels = {
  currentModelId: 'small',
  availableModels: [
    { modelId: 'small', name: 'Small' },
    { modelId: 'large', name: 'Large' },
  ],
};

describe('ACP public session settings', () => {
  it('uses the legacy model interface when modern options contain no editable controls', () => {
    for (const configOptions of [[], [modelOptions()[3]!]]) {
      expect(sessionSettingsFromResponse({ configOptions, models: legacyModels })).toEqual({
        source: 'legacy-models',
        options: [expect.objectContaining({ id: 'model', currentValue: 'small' })],
      });
    }
    expect(sessionSettingsFromResponse({ configOptions: [], models: undefined })).toEqual({
      source: 'config-options',
      options: [],
    });
  });
  it('keeps only model controls, preserves groups, and gives standard options priority over legacy', () => {
    const configOptions = modelOptions();
    configOptions[0] = {
      ...configOptions[0]!,
      type: 'select',
      currentValue: 'small',
      options: [
        { group: 'local', name: 'Local models', options: [{ value: 'small', name: 'Small' }] },
      ],
    };
    const snapshot = sessionSettingsFromResponse({ configOptions, models: legacyModels });
    expect(snapshot.source).toBe('config-options');
    expect(snapshot.options.map((option) => option.id)).toEqual([
      'model',
      'reasoning',
      'context_tokens',
    ]);
    expect(snapshot.options[0]?.options).toEqual([
      { value: 'small', name: 'Local models · Small' },
    ]);
    expect(snapshot.options[2]?.currentValue).toBe('32k');
    expect(sessionSettingsFromResponse({ modes: { currentModeId: 'yolo' } })).toEqual({
      source: 'unavailable',
      options: [],
    });
  });

  it('refuses malformed, duplicate, excessive, or sensitive public metadata without exposing it', () => {
    for (const configOptions of [
      [{ ...modelOptions()[0], currentValue: 'missing' }],
      [modelOptions()[0], modelOptions()[0]],
      Array.from({ length: 65 }, () => modelOptions()[0]),
      [{ ...modelOptions()[0], description: 'Authorization: Bearer private-value' }],
      [
        {
          ...modelOptions()[0],
          options: [{ value: 'small', name: 'https://example.com/?api_key=private' }],
        },
      ],
    ]) {
      let error: unknown;
      try {
        sessionSettingsFromResponse({ configOptions });
      } catch (failure) {
        error = failure;
      }
      expect(error).toMatchObject({ code: 'invalid-advertisement' });
      expect(String(error)).not.toContain('private');
    }
    expect(
      sessionSettingsFromResponse({
        configOptions: [
          { ...modelOptions()[0], id: 'approval_policy', category: 'model_config' },
          { ...modelOptions()[0], id: 'custom-unclassified', category: '_custom' },
        ],
      }).options,
    ).toEqual([]);
  });

  it('retains discovery/load state and applies model before dependent thought settings over SDK streams', async () => {
    const streams = streamPair();
    const requests: Array<{ configId: string; value: unknown }> = [];
    let options = modelOptions();
    const agent = acp
      .agent({ name: 'settings-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'settings',
        configOptions: options,
      }))
      .onRequest(acp.methods.agent.session.load, () => ({ configOptions: options }))
      .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
        requests.push({ configId: ctx.params.configId, value: ctx.params.value });
        options =
          ctx.params.configId === 'model'
            ? modelOptions(String(ctx.params.value))
            : modelOptions('large', String(ctx.params.value));
        return { configOptions: options };
      })
      .connect(streams.agent);
    const connection = await new AcpClientRuntime().connect(streams.client);
    try {
      const created = await connection.newSession({ cwd: '/fixture' });
      expect(created.settings?.source).toBe('config-options');
      const configured = await connection.applySessionSettings('settings', {
        reasoning: 'high',
        model: 'large',
      });
      expect(requests).toEqual([
        { configId: 'model', value: 'large' },
        { configId: 'reasoning', value: 'high' },
      ]);
      expect(configured.options[1]?.currentValue).toBe('high');
      const copy = connection.getSessionSettings('settings');
      copy.options.length = 0;
      expect(connection.getSessionSettings('settings').options).toHaveLength(3);
      options = modelOptions('large', 'low');
      expect(
        (await connection.resumeSession('settings', { cwd: '/fixture' })).settings?.options[1]
          ?.currentValue,
      ).toBe('low');
    } finally {
      connection.close();
      agent.close();
    }
  });

  it('keeps successful model changes after a dependent value becomes invalid and sends no prompt', async () => {
    const streams = streamPair();
    let prompts = 0;
    let settingCalls = 0;
    const agent = acp
      .agent({ name: 'settings-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'settings',
        configOptions: modelOptions('large', 'high'),
      }))
      .onRequest(acp.methods.agent.session.setConfigOption, () => {
        settingCalls++;
        return { configOptions: modelOptions('small') };
      })
      .onRequest(acp.methods.agent.session.prompt, () => {
        prompts++;
        return { stopReason: 'end_turn' };
      })
      .connect(streams.agent);
    const connection = await new AcpClientRuntime().connect(streams.client);
    try {
      await connection.newSession({ cwd: '/fixture' });
      await expect(
        connection.applySessionSettings('settings', { reasoning: 'high', model: 'small' }),
      ).rejects.toMatchObject({
        code: 'invalid-value',
        snapshot: {
          options: [
            expect.objectContaining({ currentValue: 'small' }),
            expect.anything(),
            expect.anything(),
          ],
        },
      });
      expect(connection.getSessionSettings('settings').options[0]?.currentValue).toBe('small');
      expect(settingCalls).toBe(1);
      expect(prompts).toBe(0);
      await expect(
        connection.applySessionSettings('settings', { mode: 'yolo' }),
      ).rejects.toMatchObject({ code: 'unsupported-option' });
      expect(settingCalls).toBe(1);
    } finally {
      connection.close();
      agent.close();
    }
  });

  it('updates settings without an active prompt and withholds opaque notification metadata', async () => {
    const streams = streamPair();
    const events: AgentEvent[] = [];
    const agent = acp
      .agent({ name: 'settings-fixture' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'settings',
        configOptions: modelOptions(),
      }))
      .connect(streams.agent);
    const connection = await new AcpClientRuntime({
      eventSink: (event) => {
        events.push(event);
      },
    }).connect(streams.client);
    try {
      await connection.newSession({ cwd: '/fixture' });
      await agent.client.notify(acp.methods.client.session.update, {
        sessionId: 'settings',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: modelOptions('large', 'high'),
          _meta: { credential: 'private-value' },
        },
      });
      // An ordered request acts as a deterministic transport barrier, no sleeps/polling.
      await connection.newSession({ cwd: '/fixture' });
      expect(events.at(-1)).toMatchObject({
        updateType: 'config_option_update',
        payload: { source: 'config-options' },
      });
      expect(JSON.stringify(events)).not.toContain('private-value');
      // newSession intentionally resets this fixture session; verify a raw complete update directly.
      await connection.handleSessionUpdate({
        sessionId: 'settings',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: modelOptions('large', 'high'),
        },
      });
      expect(connection.getSessionSettings('settings').options[1]?.currentValue).toBe('high');
    } finally {
      connection.close();
      agent.close();
    }
  });

  it('never reports a rejected or unconfirmed setting as applied', async () => {
    for (const outcome of ['reject', 'unchanged'] as const) {
      const streams = streamPair();
      const agent = acp
        .agent({ name: 'settings-fixture' })
        .onRequest(acp.methods.agent.initialize, (ctx) => ({
          protocolVersion: ctx.params.protocolVersion,
        }))
        .onRequest(acp.methods.agent.session.new, () => ({
          sessionId: 'settings',
          configOptions: modelOptions(),
        }))
        .onRequest(acp.methods.agent.session.setConfigOption, () => {
          if (outcome === 'reject') throw new Error('Bearer provider-secret');
          return { configOptions: modelOptions() };
        })
        .connect(streams.agent);
      const connection = await new AcpClientRuntime().connect(streams.client);
      try {
        await connection.newSession({ cwd: '/fixture' });
        const failure = await connection
          .applySessionSettings('settings', { model: 'large' })
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: outcome === 'reject' ? 'rejected' : 'unconfirmed' });
        expect(String(failure)).not.toContain('provider-secret');
        expect(connection.getSessionSettings('settings').options[0]?.currentValue).toBe('small');
      } finally {
        connection.close();
        agent.close();
      }
    }
  });

  it('supports legacy models only after actual model confirmation, including legacy wire notifications', async () => {
    for (const confirmed of [true, false]) {
      const streams = streamPair();
      const requests: unknown[] = [];
      const agent = acp
        .agent({ name: 'legacy-settings-fixture' })
        .onRequest(acp.methods.agent.initialize, (ctx) => ({
          protocolVersion: ctx.params.protocolVersion,
        }))
        .onRequest(acp.methods.agent.session.new, () => ({
          sessionId: 'legacy',
          models: legacyModels,
        }))
        .onRequest(
          'session/set_model',
          (params: unknown) => params as { sessionId: string; modelId: string },
          async (ctx) => {
            requests.push(ctx.params);
            if (confirmed)
              await ctx.client.notify('session/update', {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: 'current_model_update',
                  currentModelId: ctx.params.modelId,
                },
              });
            return {};
          },
        )
        .connect(streams.agent);
      const connection = await new AcpClientRuntime().connect(streams.client);
      try {
        expect((await connection.newSession({ cwd: '/fixture' })).settings?.source).toBe(
          'legacy-models',
        );
        if (confirmed)
          expect(
            (await connection.applySessionSettings('legacy', { model: 'large' })).options[0]
              ?.currentValue,
          ).toBe('large');
        else
          await expect(
            connection.applySessionSettings('legacy', { model: 'large' }),
          ).rejects.toMatchObject({ code: 'unconfirmed' });
        expect(requests).toEqual([{ sessionId: 'legacy', modelId: 'large' }]);
      } finally {
        connection.close();
        agent.close();
      }
    }
  });

  it('enriches Antigravity session settings with known candidate models', () => {
    const rawOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-3.8-flash',
        options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
      },
      {
        id: 'thinking_level',
        name: 'Thinking Level',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ];
    const snapshot = sessionSettingsFromResponse(
      { configOptions: rawOptions },
      { name: 'antigravity-acp', version: '1.4.1' },
    );
    expect(snapshot.source).toBe('config-options');
    const modelOption = snapshot.options.find((opt) => opt.id === 'model');
    expect(modelOption).toBeDefined();
    const modelValues = modelOption!.options.map((opt) => opt.value);
    expect(modelValues).toContain('gemini-3.8-flash');
    expect(modelValues).toContain('claude-sonnet-4.6');
    expect(modelValues).toContain('claude-opus-4.6');
    expect(modelValues).toContain('gpt-oss-120b');
    expect(modelValues).toContain('gemini-4-argon');
  });
});
