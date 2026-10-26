import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { SessionSettingValuesSchema, type SessionSettingsSnapshot } from '@control-plane/core';
import {
  AcpSessionSettingsError,
  legacyModelUpdate,
  sessionSettingsFromResponse,
  unavailableSessionSettings,
} from './session-settings.js';
import { promptUsage } from './usage.js';
import { TerminalAuthMethodSchema } from './terminal-auth.js';
import { AcpTurnFailure, nativeTurnFailure } from './turn-failure.js';
import { DenyByDefaultPermissionBroker } from './permission.js';
import {
  PermissionReviewCollector,
  permissionIdentity,
  permissionWireShape,
  redactPermissionValue,
  type PermissionWireShape,
  type PermissionSemantics,
} from './permission-review.js';
import type {
  AgentNegotiation,
  AgentEvent,
  AgentEventSink,
  AgentReadiness,
  NewSessionInput,
  PermissionBroker,
  PermissionDecision,
  PermissionRequest,
  SessionRef,
  PromptAttachment,
} from './types.js';

type PromptQueue = {
  push(event: AgentEvent): void;
  fail(error: unknown): void;
  next(): Promise<AgentEvent>;
};

function createPromptQueue(): PromptQueue {
  const values: AgentEvent[] = [];
  const waiters: Array<{
    resolve(value: AgentEvent): void;
    reject(error: unknown): void;
  }> = [];
  let failure: unknown;
  let failed = false;

  return {
    push(event) {
      if (failed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(event);
      } else {
        values.push(event);
      }
    },
    fail(error) {
      if (failed) {
        return;
      }
      failed = true;
      failure = error;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
    next() {
      const event = values.shift();
      if (event) {
        return Promise.resolve(event);
      }
      if (failed) {
        return Promise.reject(failure);
      }
      return new Promise<AgentEvent>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

function normalizePermissionRequest(params: acp.RequestPermissionRequest): PermissionRequest {
  return {
    sessionId: String(params.sessionId),
    options: params.options.map((option) => ({
      optionId: String(option.optionId),
      name: option.name,
      ...(option.kind == null ? {} : { kind: String(option.kind) }),
    })),
    subject: redactPermissionValue(params.toolCall).value,
  };
}

function toPermissionResponse(decision: PermissionDecision): acp.RequestPermissionResponse {
  if (decision.outcome === 'selected') {
    return {
      outcome: {
        outcome: 'selected',
        optionId: decision.optionId,
      },
    };
  }

  return {
    outcome: {
      outcome: 'cancelled',
    },
  };
}

function normalizeSessionUpdate(params: acp.SessionNotification): AgentEvent {
  const sessionId = String(params.sessionId);
  const update = params.update;
  if (update.sessionUpdate === 'user_message_chunk' && update.content.type !== 'text') {
    return {
      type: 'status',
      sessionId,
      updateType: update.sessionUpdate,
      payload: {
        sessionUpdate: update.sessionUpdate,
        content: {
          type: update.content.type,
          note: 'Input attachment bytes are retained by the host, not duplicated into events.',
        },
      },
    };
  }

  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return {
      type: 'text_delta',
      sessionId,
      text: update.content.text,
    };
  }

  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    return {
      type: 'tool',
      sessionId,
      updateType: update.sessionUpdate,
      payload: redactPermissionValue(update).value,
    };
  }

  return {
    type: 'status',
    sessionId,
    updateType: update.sessionUpdate,
    payload: redactPermissionValue(update).value,
  };
}

// Protocol data is untrusted; opaque extension values and credential-like keys
// never enter the public observation. Bounds also protect the settings view.
function publicProtocolValue(
  value: unknown,
  depth = 0,
  budget = { nodes: 1000, characters: 32768 },
): unknown {
  if (depth > 6 || budget.nodes-- <= 0 || budget.characters <= 0) {
    return Array.isArray(value)
      ? ['[truncated]']
      : value && typeof value === 'object'
        ? { __truncated: true }
        : '[truncated]';
  }
  if (typeof value === 'string') {
    const length = Math.min(value.length, 2048, budget.characters);
    budget.characters -= length;
    return value.slice(0, length) + (length < value.length ? '…[truncated]' : '');
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value.slice(0, 100)) {
      if (budget.nodes <= 0 || budget.characters <= 0) {
        result.push('[truncated]');
        break;
      }
      result.push(publicProtocolValue(item, depth + 1, budget));
    }
    if (value.length > 100) result.push('[truncated]');
    return result;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [originalKey, item] of Object.entries(value).slice(0, 100)) {
      if (budget.nodes <= 0 || budget.characters <= 0) {
        result.__truncated = true;
        break;
      }
      const key = originalKey.slice(0, 256);
      budget.characters -= key.length;
      // Define properties without invoking __proto__ setters on untrusted keys.
      const next =
        key === '_meta'
          ? {
              advertisedKeys:
                item && typeof item === 'object'
                  ? Object.keys(item)
                      .slice(0, 20)
                      .flatMap((k) => {
                        if (budget.characters <= 0) return [];
                        const key = k.slice(0, Math.min(128, budget.characters));
                        budget.characters -= key.length;
                        return [key];
                      })
                  : [],
              values: '[extension values withheld]',
            }
          : /token|secret|credential|authorization|password|cookie|api.?key/i.test(key)
            ? '[redacted]'
            : publicProtocolValue(item, depth + 1, budget);
      Object.defineProperty(result, key, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (Object.keys(value).length > 100) result.__truncated = true;
    return result;
  }
  return value ?? null;
}

export type AcpRuntimeOptions = {
  terminalAuthentication?: boolean;
  permissionContentSummarizer?: (request: {
    sessionId: string;
    agentInfo: { name: string; version: string } | null;
    toolCall: Readonly<Record<string, unknown>>;
  }) => Record<string, unknown> | null;
  clientName?: string;
  permissionBroker?: PermissionBroker;
  eventSink?: AgentEventSink;
  permissionTtlMs?: number;
  permissionResolver?: (request: {
    sessionId: string;
    agentInfo: { name: string; version: string } | null;
    toolCall: Readonly<Record<string, unknown>>;
  }) => PermissionSemantics | null;
  permissionMetadataValidator?: (request: {
    sessionId: string;
    agentInfo: { name: string; version: string } | null;
    metadata: unknown;
  }) => boolean;
  permissionContentMetadataValidator?: (request: {
    sessionId: string;
    agentInfo: { name: string; version: string } | null;
    toolCall: Readonly<Record<string, unknown>>;
    metadata: unknown;
  }) => boolean;
};

export class AcpRuntimeConnection {
  private readonly promptQueues = new Map<string, PromptQueue>();
  private readonly promptLifetimes = new Map<string, AbortController>();
  private stopped = false;
  private authState: AgentReadiness['auth'];
  private readonly settings = new Map<string, SessionSettingsSnapshot>();
  private readonly invalidSettings = new Set<string>();
  private readonly changingSettings = new Set<string>();

  constructor(
    private readonly connection: acp.ClientConnection,
    private readonly initialized: acp.InitializeResponse,
    private readonly permissionBroker: PermissionBroker,
    private readonly eventSink?: AgentEventSink,
    private readonly permissionReviews = new PermissionReviewCollector(),
  ) {
    // Do not rely on a pending SDK request settling after the transport disappears.
    // Wake streaming consumers and revoke outstanding permissions immediately.
    connection.signal?.addEventListener(
      'abort',
      () => {
        this.invalidatePermissions();
        for (const queue of this.promptQueues.values())
          queue.fail(new AcpTurnFailure('ACP_CONNECTION_CLOSED'));
      },
      { once: true },
    );
    void connection.closed.then(
      () => this.invalidatePermissions(),
      () => this.invalidatePermissions(),
    );
    // Reject excessive authentication metadata rather than shortening executable IDs.
    // All public copies below share these limits; original IDs remain unchanged.
    const methods = initialized.authMethods ?? [];
    if (
      methods.length > 32 ||
      methods.some(
        (method) =>
          method.id.length > 256 ||
          method.name.length > 256 ||
          ('type' in method && String(method.type).length > 64),
      ) ||
      Buffer.byteLength(
        JSON.stringify(
          methods.map((method) => ({
            id: method.id,
            name: method.name,
            ...('type' in method ? { type: method.type } : {}),
          })),
        ),
      ) > 8192
    ) {
      throw new RangeError('Agent authentication metadata exceeds the public observation limit.');
    }
    this.authState = methods.length ? 'unknown' : 'not_reported';
  }

  get readiness(): AgentReadiness {
    return {
      runtime: 'ready',
      auth: this.authState,
      observedAt: new Date().toISOString(),
      authMethodIds: (this.initialized.authMethods ?? []).map((method) => method.id),
    };
  }

  get capabilities(): acp.AgentCapabilities {
    return structuredClone(this.initialized.agentCapabilities ?? {});
  }

  get negotiation(): AgentNegotiation {
    const budget = { nodes: 1000, characters: 8192 };
    const value: AgentNegotiation = {
      protocolVersion: this.initialized.protocolVersion,
      agentInfo: this.initialized.agentInfo
        ? (publicProtocolValue(this.initialized.agentInfo, 0, budget) as Record<string, unknown>)
        : null,
      agentCapabilities: publicProtocolValue(
        this.initialized.agentCapabilities ?? {},
        0,
        budget,
      ) as Record<string, unknown>,
      authMethods: publicProtocolValue(this.authMethods, 0, budget) as unknown[],
      note: 'Protocol advertisement only; no model execution verified. Opaque extensions withheld; values bounded and sensitive keys redacted.',
    };
    // Bound UTF-8 bytes as well as characters, including JSON escaping/structure.
    // Together with the <=8KiB auth summaries and IDs, an observation is <64KiB.
    if (Buffer.byteLength(JSON.stringify(value)) > 32768) {
      return {
        protocolVersion: value.protocolVersion,
        agentInfo: null,
        agentCapabilities: { __truncated: true },
        authMethods: [],
        note: 'Protocol advertisement truncated: public observation byte limit exceeded; no model execution verified.',
      };
    }
    return value;
  }

  get authMethods(): acp.AuthMethod[] {
    return (this.initialized.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      ...('type' in method && method.type !== undefined ? { type: method.type } : {}),
    })) as acp.AuthMethod[];
  }

  async authenticate(methodId: string): Promise<void> {
    const method = (this.initialized.authMethods ?? []).find(
      (candidate) => candidate.id === methodId,
    );
    if (!method) {
      throw new RangeError(`Authentication method not advertised: ${methodId}`);
    }
    if ('type' in method && method.type === 'terminal') {
      throw new TypeError(
        'Terminal authentication must be executed by a runner, not ACP authenticate.',
      );
    }
    if ('type' in method && method.type !== undefined && String(method.type) !== 'agent')
      throw new TypeError('This authentication method does not use ACP authenticate.');

    await this.connection.agent.request(acp.methods.agent.authenticate, { methodId });
    this.authState = 'ready';
  }

  /** Executable setup metadata remains private to the host adapter, never in public observations. */
  terminalAuthentication(methodId: string) {
    const method = (this.initialized.authMethods ?? []).find(
      (candidate) => candidate.id === methodId,
    );
    const parsed = TerminalAuthMethodSchema.safeParse(method);
    if (!parsed.success)
      throw new TypeError('Agent returned invalid terminal authentication metadata.');
    return parsed.data;
  }

  async newSession(input: NewSessionInput): Promise<SessionRef> {
    const response = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: (input.mcpServers ?? []) as acp.McpServer[],
    });

    const sessionId = String(response.sessionId);
    this.recordSessionSettings(sessionId, response);
    return { sessionId, settings: this.getSessionSettings(sessionId) };
  }

  async resumeSession(sessionId: string, input: NewSessionInput): Promise<SessionRef> {
    if (this.initialized.agentCapabilities?.loadSession !== true) {
      throw new Error('Agent does not advertise loadSession capability.');
    }

    const response = await this.connection.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd: input.cwd,
      mcpServers: (input.mcpServers ?? []) as acp.McpServer[],
    });

    this.recordSessionSettings(sessionId, response);
    return { sessionId, settings: this.getSessionSettings(sessionId) };
  }

  getSessionSettings(sessionId: string): SessionSettingsSnapshot {
    const snapshot = this.settings.get(sessionId) ?? unavailableSessionSettings();
    if (this.invalidSettings.has(sessionId))
      throw new AcpSessionSettingsError('invalid-advertisement', snapshot);
    return structuredClone(snapshot);
  }

  async applySessionSettings(
    sessionId: string,
    values: Record<string, string>,
  ): Promise<SessionSettingsSnapshot> {
    const initial = this.getSessionSettings(sessionId);
    if (this.stopped) throw new AcpSessionSettingsError('closed', initial);
    if (this.promptQueues.has(sessionId) || this.changingSettings.has(sessionId))
      throw new AcpSessionSettingsError('busy', initial);
    const parsed = SessionSettingValuesSchema.safeParse(values);
    if (!parsed.success) throw new AcpSessionSettingsError('invalid-values', initial);
    const entries = Object.entries(parsed.data);
    for (const [id] of entries)
      if (!initial.options.some((option) => option.id === id))
        throw new AcpSessionSettingsError('unsupported-option', initial);
    entries.sort(([left], [right]) => {
      const model = (id: string) =>
        initial.options.find((option) => option.id === id)?.category === 'model' || id === 'model';
      return Number(model(right)) - Number(model(left));
    });

    this.changingSettings.add(sessionId);
    try {
      for (const [id, value] of entries) {
        // Changing the model may replace all dependent choices. Never validate a thought
        // level only against the old model, and never reuse the old options after a reply.
        const snapshot = this.getSessionSettings(sessionId);
        const option = snapshot.options.find((candidate) => candidate.id === id);
        if (!option) throw new AcpSessionSettingsError('unsupported-option', snapshot);
        if (!option.options.some((candidate) => candidate.value === value))
          throw new AcpSessionSettingsError('invalid-value', snapshot);
        if (option.currentValue === value) continue;
        let response: unknown;
        try {
          response =
            snapshot.source === 'legacy-models'
              ? await this.connection.agent.request<unknown>('session/set_model', {
                  sessionId,
                  modelId: value,
                })
              : await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
                  sessionId,
                  configId: id,
                  value,
                });
        } catch {
          throw new AcpSessionSettingsError('rejected', this.getSessionSettings(sessionId));
        }
        let updated: SessionSettingsSnapshot;
        try {
          updated = sessionSettingsFromResponse(response);
        } catch {
          this.invalidSettings.add(sessionId);
          throw new AcpSessionSettingsError('invalid-advertisement', snapshot);
        }
        if (updated.source !== 'unavailable') this.recordSessionSettings(sessionId, response);
        if (snapshot.source !== 'legacy-models' && updated.source !== 'config-options')
          throw new AcpSessionSettingsError('unconfirmed', this.getSessionSettings(sessionId));
        // Old set_model replies may be empty; only a genuine current_model_update or a
        // complete models response can confirm them. An acknowledgement is not a readback.
        const confirmed = this.getSessionSettings(sessionId);
        if (confirmed.options.find((candidate) => candidate.id === id)?.currentValue !== value)
          throw new AcpSessionSettingsError('unconfirmed', confirmed);
      }
      const confirmed = this.getSessionSettings(sessionId);
      if (
        entries.some(
          ([id, value]) =>
            confirmed.options.find((candidate) => candidate.id === id)?.currentValue !== value,
        )
      )
        throw new AcpSessionSettingsError('unconfirmed', confirmed);
      return confirmed;
    } finally {
      // Successful earlier changes remain real when a later setting fails. No rollback
      // is claimed: callers can show the last confirmed state and retry deliberately.
      this.changingSettings.delete(sessionId);
    }
  }

  private recordSessionSettings(sessionId: string, response: unknown): void {
    try {
      const snapshot = sessionSettingsFromResponse(response);
      this.settings.set(sessionId, snapshot);
      this.invalidSettings.delete(sessionId);
    } catch {
      this.invalidSettings.add(sessionId);
      throw new AcpSessionSettingsError(
        'invalid-advertisement',
        this.settings.get(sessionId) ?? unavailableSessionSettings(),
      );
    }
  }

  async handleLegacyModelUpdate(sessionId: string, value: unknown): Promise<void> {
    const previous = this.settings.get(sessionId);
    if (!previous || previous.source !== 'legacy-models') return;
    try {
      this.settings.set(sessionId, legacyModelUpdate(previous, value));
      this.invalidSettings.delete(sessionId);
      const event: AgentEvent = {
        type: 'status',
        sessionId,
        updateType: 'config_option_update',
        payload: this.getSessionSettings(sessionId),
      };
      this.promptQueues.get(sessionId)?.push(event);
      await this.emit(event);
    } catch {
      this.invalidSettings.add(sessionId);
    }
  }

  async *prompt(
    sessionId: string,
    text: string,
    attachments: PromptAttachment[] = [],
  ): AsyncGenerator<AgentEvent, void, void> {
    if (
      !Array.isArray(attachments) ||
      attachments.length > 40 ||
      attachments.some((item) =>
        item.type === 'image'
          ? !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mimeType) ||
            typeof item.data !== 'string' ||
            item.data.length > 28 * 1024 * 1024 ||
            !/^[a-zA-Z0-9+/]+={0,2}$/.test(item.data)
          : item.type !== 'resource_link' ||
            typeof item.uri !== 'string' ||
            !item.uri.startsWith('file:///') ||
            typeof item.name !== 'string' ||
            item.name.length > 255 ||
            !Number.isSafeInteger(item.size) ||
            item.size < 1,
      )
    )
      throw new TypeError('Invalid ACP input attachment.');
    if (
      attachments.some((a) => a.type === 'image') &&
      !this.initialized.agentCapabilities?.promptCapabilities?.image
    )
      throw new Error(
        '此成员未声明图片输入能力，未发送模型提示；附件与已有改动仍保留，请选择支持图片的成员。',
      );
    if (this.changingSettings.has(sessionId))
      throw new AcpSessionSettingsError('busy', this.getSessionSettings(sessionId));
    if (this.invalidSettings.has(sessionId)) this.getSessionSettings(sessionId);
    if (this.promptQueues.has(sessionId)) {
      throw new Error(`A prompt is already active for session ${sessionId}.`);
    }

    const queue = createPromptQueue();
    const lifetime = new AbortController();
    this.permissionReviews.clear(sessionId);
    this.promptLifetimes.set(sessionId, lifetime);
    this.promptQueues.set(sessionId, queue);

    const prompt: acp.ContentBlock[] = [{ type: 'text', text }, ...attachments];
    const request = this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    });

    void request.then(
      async (response) => {
        lifetime.abort();
        const usage = promptUsage((response as { usage?: unknown }).usage);
        const event: AgentEvent = {
          type: 'completed',
          sessionId,
          stopReason: String(response.stopReason),
          ...(usage ? { usage } : {}),
        };
        queue.push(event);
      },
      (error) => {
        // The consumer can remain paused at yield, so finally is too late.
        lifetime.abort();
        this.permissionReviews.clear(sessionId);
        queue.fail(
          this.connection.signal?.aborted ? new AcpTurnFailure('ACP_CONNECTION_CLOSED') : error,
        );
      },
    );

    let observedOutput = '';
    try {
      for (;;) {
        const event = await queue.next();
        if (event.type === 'text_delta') {
          // Once beyond the sentinel bound it cannot match; do not duplicate a large transcript.
          if (observedOutput.length <= 1024) observedOutput += event.text.slice(0, 1025);
        }
        if (event.type === 'completed') {
          const failure = nativeTurnFailure(this.initialized.agentInfo ?? null, observedOutput);
          if (failure) {
            await this.emit({
              type: 'status',
              sessionId,
              updateType: 'turn_failed',
              payload: failure,
            });
            throw new AcpTurnFailure(failure.code);
          }
          await this.emit(event);
        }
        yield event;
        if (event.type === 'completed') {
          return;
        }
      }
    } finally {
      lifetime.abort();
      this.promptLifetimes.delete(sessionId);
      this.permissionReviews.clear(sessionId);
      this.promptQueues.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.promptLifetimes.get(sessionId)?.abort();
    this.permissionReviews.clear(sessionId);
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  close(error?: unknown): void {
    this.invalidatePermissions();
    this.connection.close(error);
  }

  private invalidatePermissions(): void {
    this.stopped = true;
    for (const lifetime of this.promptLifetimes.values()) lifetime.abort();
    this.permissionReviews.clear();
  }

  async closed(): Promise<void> {
    await this.connection.closed;
  }

  async handleSessionUpdate(
    params: acp.SessionNotification,
    wire?: PermissionWireShape,
  ): Promise<void> {
    if (params.update.sessionUpdate === 'config_option_update') {
      let event: AgentEvent;
      try {
        this.recordSessionSettings(params.sessionId, params.update);
        event = {
          type: 'status',
          sessionId: params.sessionId,
          updateType: 'config_option_update',
          payload: this.getSessionSettings(params.sessionId),
        };
      } catch {
        event = {
          type: 'status',
          sessionId: params.sessionId,
          updateType: 'session_settings_invalid',
          payload: { code: 'invalid-advertisement' },
        };
      }
      this.promptQueues.get(event.sessionId)?.push(event);
      await this.emit(event);
      return;
    }
    if (
      this.promptLifetimes.get(params.sessionId)?.signal.aborted === false &&
      ['tool_call', 'tool_call_update'].includes(params.update.sessionUpdate)
    )
      this.permissionReviews.observe(params.sessionId, params.update, wire);
    const event = normalizeSessionUpdate(params);
    this.promptQueues.get(event.sessionId)?.push(event);
    await this.emit(event);
  }

  async handlePermissionRequest(
    params: acp.RequestPermissionRequest,
    wire?: PermissionWireShape,
    transportSignal?: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const lifetime = this.promptLifetimes.get(params.sessionId);
    if (
      this.stopped ||
      !lifetime ||
      lifetime.signal.aborted ||
      transportSignal?.aborted ||
      params.sessionId.length > 256 ||
      params.toolCall.toolCallId.length > 256 ||
      params.options.length > 16 ||
      params.options.some((option) => option.optionId.length > 256) ||
      new Set(params.options.map((option) => option.optionId)).size !== params.options.length
    )
      return toPermissionResponse({ outcome: 'cancelled' });
    const normalized = normalizePermissionRequest(params);
    normalized.review = this.permissionReviews.review(params.sessionId, params.toolCall, wire);
    normalized.requestId = randomUUID();
    normalized.signal = transportSignal
      ? AbortSignal.any([lifetime.signal, transportSignal])
      : lifetime.signal;
    const event: AgentEvent = {
      type: 'permission_request',
      sessionId: normalized.sessionId,
      optionIds: normalized.options.map((option) => option.optionId),
    };
    this.promptQueues.get(normalized.sessionId)?.push(event);
    await this.emit(event);

    const decision = await this.permissionBroker.decide(normalized);
    if (normalized.signal.aborted || this.stopped)
      return toPermissionResponse({ outcome: 'cancelled' });
    if (
      decision.outcome === 'selected' &&
      !normalized.options.some(
        (option) => option.optionId === decision.optionId && option.kind === 'allow_once',
      )
    )
      return toPermissionResponse({ outcome: 'cancelled' });
    return toPermissionResponse(decision);
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.eventSink?.(event);
  }
}

export class AcpClientRuntime {
  private readonly clientName: string;
  private readonly permissionBroker: PermissionBroker;
  private readonly eventSink: AgentEventSink | undefined;
  private readonly optionsPermissionTtlMs: number;
  private readonly permissionResolver: AcpRuntimeOptions['permissionResolver'];
  private readonly permissionMetadataValidator: AcpRuntimeOptions['permissionMetadataValidator'];
  private readonly permissionContentMetadataValidator: AcpRuntimeOptions['permissionContentMetadataValidator'];
  private readonly permissionContentSummarizer: AcpRuntimeOptions['permissionContentSummarizer'];
  private readonly terminalAuthentication: boolean;

  constructor(options: AcpRuntimeOptions = {}) {
    this.clientName = options.clientName ?? 'multi-agent-control-plane';
    this.terminalAuthentication = options.terminalAuthentication === true;
    this.permissionBroker = options.permissionBroker ?? new DenyByDefaultPermissionBroker();
    this.eventSink = options.eventSink;
    this.optionsPermissionTtlMs = options.permissionTtlMs ?? 300_000;
    this.permissionResolver = options.permissionResolver;
    this.permissionMetadataValidator = options.permissionMetadataValidator;
    this.permissionContentMetadataValidator = options.permissionContentMetadataValidator;
    this.permissionContentSummarizer = options.permissionContentSummarizer;
  }

  async connect(stream: acp.Stream): Promise<AcpRuntimeConnection> {
    let runtimeConnection: AcpRuntimeConnection | undefined;
    const permissionShapes = new Map<string, PermissionWireShape>();
    const updateShapes = new Map<string, PermissionWireShape[]>();
    const updateKey = (params: acp.SessionNotification) =>
      permissionIdentity(
        JSON.stringify([params.sessionId, (params.update as { toolCallId?: string }).toolCallId]),
      );
    const observed: acp.Stream = {
      writable: stream.writable,
      readable: stream.readable.pipeThrough(
        new TransformStream({
          transform(message, controller) {
            if (
              'method' in message &&
              message.method === 'session/request_permission' &&
              'id' in message
            ) {
              const shape = permissionWireShape(
                (message.params as acp.RequestPermissionRequest)?.toolCall,
              );
              shape.envelopeFiltered = Object.keys(message.params ?? {}).some(
                (key) => !['sessionId', 'toolCall', 'options', '_meta'].includes(key),
              );
              permissionShapes.set(String(message.id), shape);
              while (permissionShapes.size > 64)
                permissionShapes.delete(permissionShapes.keys().next().value!);
            }
            if ('method' in message && message.method === 'session/update') {
              const params = message.params as acp.SessionNotification;
              // The current SDK no longer accepts this legacy notification variant.
              // Consume it before SDK validation, retaining only the public model ID.
              const update = params?.update as unknown as Record<string, unknown> | undefined;
              if (update?.sessionUpdate === 'config_option_update') {
                // SDK permissive parsing can skip malformed individual selectors. Validate
                // the complete raw snapshot instead, so partial metadata never looks complete.
                if (typeof params.sessionId === 'string' && params.sessionId.length <= 256)
                  void runtimeConnection?.handleSessionUpdate(params).catch(() => undefined);
                return;
              }
              if (update?.sessionUpdate === 'current_model_update') {
                if (typeof params.sessionId === 'string' && params.sessionId.length <= 256)
                  void runtimeConnection
                    ?.handleLegacyModelUpdate(params.sessionId, update.currentModelId)
                    .catch(() => undefined);
                return;
              }
              if (
                params?.update &&
                ['tool_call', 'tool_call_update'].includes(params.update.sessionUpdate)
              ) {
                const key = updateKey(params),
                  queue = updateShapes.get(key) ?? [];
                const shape = permissionWireShape(params.update);
                shape.envelopeFiltered = Object.keys(params).some(
                  (key) => !['sessionId', 'update', '_meta'].includes(key),
                );
                queue.push(shape);
                if (queue.length > 32) queue.shift();
                updateShapes.set(key, queue);
                while (updateShapes.size > 32)
                  updateShapes.delete(updateShapes.keys().next().value!);
              }
            }
            controller.enqueue(message);
          },
        }),
      ),
    };

    const app = acp
      .client({ name: this.clientName })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        if (!runtimeConnection) {
          return { outcome: { outcome: 'cancelled' } };
        }
        const key = String(ctx.requestId),
          shape = permissionShapes.get(key);
        permissionShapes.delete(key);
        return runtimeConnection.handlePermissionRequest(ctx.params, shape, ctx.signal);
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        const key = updateKey(ctx.params),
          queue = updateShapes.get(key),
          shape = queue?.shift();
        if (!queue?.length) updateShapes.delete(key);
        await runtimeConnection?.handleSessionUpdate(ctx.params, shape);
      });

    const connection = app.connect(observed);
    void connection.closed
      .finally(() => {
        permissionShapes.clear();
        updateShapes.clear();
      })
      .catch(() => undefined);
    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.terminalAuthentication ? { auth: { terminal: true } } : {},
    });

    runtimeConnection = new AcpRuntimeConnection(
      connection,
      initialized,
      this.permissionBroker,
      this.eventSink,
      new PermissionReviewCollector(
        Date.now,
        this.optionsPermissionTtlMs,
        (sessionId, toolCall) =>
          this.permissionResolver?.({
            sessionId,
            toolCall,
            agentInfo: initialized.agentInfo
              ? { name: initialized.agentInfo.name, version: initialized.agentInfo.version }
              : null,
          }) ?? null,
        (sessionId, metadata) =>
          this.permissionMetadataValidator?.({
            sessionId,
            metadata,
            agentInfo: initialized.agentInfo
              ? { name: initialized.agentInfo.name, version: initialized.agentInfo.version }
              : null,
          }) ?? false,
        (sessionId, toolCall, metadata) =>
          this.permissionContentMetadataValidator?.({
            sessionId,
            toolCall,
            metadata,
            agentInfo: initialized.agentInfo
              ? { name: initialized.agentInfo.name, version: initialized.agentInfo.version }
              : null,
          }) ?? false,
        (sessionId, toolCall) =>
          this.permissionContentSummarizer?.({
            sessionId,
            toolCall,
            agentInfo: initialized.agentInfo
              ? { name: initialized.agentInfo.name, version: initialized.agentInfo.version }
              : null,
          }) ?? null,
      ),
    );

    return runtimeConnection;
  }
}
