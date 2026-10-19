import * as acp from '@agentclientprotocol/sdk';
import { DenyByDefaultPermissionBroker } from './permission.js';
import type {
  AgentEvent,
  AgentEventSink,
  AgentReadiness,
  NewSessionInput,
  PermissionBroker,
  PermissionDecision,
  PermissionRequest,
  SessionRef,
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
      kind: option.kind == null ? undefined : String(option.kind),
    })),
    subject: params.toolCall,
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
      payload: structuredClone(update),
    };
  }

  return {
    type: 'status',
    sessionId,
    updateType: update.sessionUpdate,
    payload: structuredClone(update),
  };
}

export type AcpRuntimeOptions = {
  clientName?: string;
  permissionBroker?: PermissionBroker;
  eventSink?: AgentEventSink;
};

export class AcpRuntimeConnection {
  private readonly promptQueues = new Map<string, PromptQueue>();
  private authState: AgentReadiness['auth'];

  constructor(
    private readonly connection: acp.ClientConnection,
    private readonly initialized: acp.InitializeResponse,
    private readonly permissionBroker: PermissionBroker,
    private readonly eventSink?: AgentEventSink,
  ) {
    this.authState = initialized.authMethods?.length ? 'unknown' : 'not_reported';
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
    return structuredClone(this.initialized.agentCapabilities);
  }

  get authMethods(): acp.AuthMethod[] {
    return structuredClone(this.initialized.authMethods ?? []);
  }

  async authenticate(methodId: string): Promise<void> {
    const method = (this.initialized.authMethods ?? []).find((candidate) => candidate.id === methodId);
    if (!method) {
      throw new RangeError(`Authentication method not advertised: ${methodId}`);
    }
    if (method.type === 'terminal') {
      throw new TypeError('Terminal authentication must be executed by a runner, not ACP authenticate.');
    }

    await this.connection.agent.request(acp.methods.agent.authenticate, { methodId });
    this.authState = 'ready';
  }

  async newSession(input: NewSessionInput): Promise<SessionRef> {
    const response = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: (input.mcpServers ?? []) as acp.McpServer[],
    });

    return {
      sessionId: String(response.sessionId),
    };
  }

  async resumeSession(sessionId: string, input: NewSessionInput): Promise<SessionRef> {
    if (this.initialized.agentCapabilities?.loadSession !== true) {
      throw new Error('Agent does not advertise loadSession capability.');
    }

    await this.connection.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd: input.cwd,
      mcpServers: (input.mcpServers ?? []) as acp.McpServer[],
    });

    return { sessionId };
  }

  async *prompt(sessionId: string, text: string): AsyncGenerator<AgentEvent, void, void> {
    if (this.promptQueues.has(sessionId)) {
      throw new Error(`A prompt is already active for session ${sessionId}.`);
    }

    const queue = createPromptQueue();
    this.promptQueues.set(sessionId, queue);

    const request = this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    });

    void request.then(
      async (response) => {
        const event: AgentEvent = {
          type: 'completed',
          sessionId,
          stopReason: String(response.stopReason),
        };
        queue.push(event);
        await this.emit(event);
      },
      (error) => queue.fail(error),
    );

    try {
      for (;;) {
        const event = await queue.next();
        yield event;
        if (event.type === 'completed') {
          return;
        }
      }
    } finally {
      this.promptQueues.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  close(error?: unknown): void {
    this.connection.close(error);
  }

  async closed(): Promise<void> {
    await this.connection.closed;
  }

  async handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    const event = normalizeSessionUpdate(params);
    this.promptQueues.get(event.sessionId)?.push(event);
    await this.emit(event);
  }

  async handlePermissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const normalized = normalizePermissionRequest(params);
    const event: AgentEvent = {
      type: 'permission_request',
      sessionId: normalized.sessionId,
      optionIds: normalized.options.map((option) => option.optionId),
    };
    this.promptQueues.get(normalized.sessionId)?.push(event);
    await this.emit(event);

    const decision = await this.permissionBroker.decide(normalized);
    return toPermissionResponse(decision);
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.eventSink?.(event);
  }
}

export class AcpClientRuntime {
  private readonly clientName: string;
  private readonly permissionBroker: PermissionBroker;
  private readonly eventSink?: AgentEventSink;

  constructor(options: AcpRuntimeOptions = {}) {
    this.clientName = options.clientName ?? 'multi-agent-control-plane';
    this.permissionBroker = options.permissionBroker ?? new DenyByDefaultPermissionBroker();
    this.eventSink = options.eventSink;
  }

  async connect(stream: acp.Stream): Promise<AcpRuntimeConnection> {
    let runtimeConnection: AcpRuntimeConnection | undefined;

    const app = acp
      .client({ name: this.clientName })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        if (!runtimeConnection) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return runtimeConnection.handlePermissionRequest(ctx.params);
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        await runtimeConnection?.handleSessionUpdate(ctx.params);
      });

    const connection = app.connect(stream);
    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    runtimeConnection = new AcpRuntimeConnection(
      connection,
      initialized,
      this.permissionBroker,
      this.eventSink,
    );

    return runtimeConnection;
  }
}
