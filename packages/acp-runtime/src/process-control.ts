import * as acp from '@agentclientprotocol/sdk';
import type { AgentDefinition } from '@control-plane/core';
import type { ProcessHandle, Runner } from '@control-plane/runner';
import { AcpClientRuntime, type AcpRuntimeConnection } from './runtime.js';
import type { AgentReadiness } from './types.js';

export type AgentAuthMethodSummary = {
  id: string;
  name: string;
  type?: string | undefined;
};

export type AgentRuntimeObservation = {
  readiness: AgentReadiness;
  authMethods: AgentAuthMethodSummary[];
};

export interface AgentRuntimeControl {
  probe(definition: AgentDefinition): Promise<AgentRuntimeObservation>;
  authenticate(
    definition: AgentDefinition,
    methodId: string,
  ): Promise<AgentRuntimeObservation>;
}

export type ProcessAgentRuntimeControlOptions = {
  probeTimeoutMs?: number | undefined;
  authenticationTimeoutMs?: number | undefined;
  runtimeFactory?: (() => AcpClientRuntime) | undefined;
};

type StartedConnection = {
  handle: ProcessHandle;
  connection: AcpRuntimeConnection;
};

function environmentFor(definition: AgentDefinition): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of definition.runtime.environmentAllowlist ?? []) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function authMethods(connection: AcpRuntimeConnection): AgentAuthMethodSummary[] {
  return connection.authMethods.map((method) => ({
    id: method.id,
    name: method.name,
    ...('type' in method && method.type !== undefined ? { type: String(method.type) } : {}),
  }));
}

function observation(connection: AcpRuntimeConnection): AgentRuntimeObservation {
  return {
    readiness: connection.readiness,
    authMethods: authMethods(connection),
  };
}

export class ProcessAgentRuntimeControl implements AgentRuntimeControl {
  private readonly probeTimeoutMs: number;
  private readonly authenticationTimeoutMs: number;
  private readonly runtimeFactory: () => AcpClientRuntime;

  constructor(
    private readonly runner: Runner,
    options: ProcessAgentRuntimeControlOptions = {},
  ) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5 * 60_000;
    this.runtimeFactory = options.runtimeFactory ?? (() => new AcpClientRuntime());
  }

  async probe(definition: AgentDefinition): Promise<AgentRuntimeObservation> {
    return this.withConnection(definition, this.probeTimeoutMs, async (connection) =>
      observation(connection),
    );
  }

  async authenticate(
    definition: AgentDefinition,
    methodId: string,
  ): Promise<AgentRuntimeObservation> {
    return this.withConnection(
      definition,
      this.authenticationTimeoutMs,
      async (connection) => {
        const method = connection.authMethods.find((candidate) => candidate.id === methodId);
        if (!method) {
          throw new RangeError(`Authentication method not advertised: ${methodId}`);
        }
        if ('type' in method && method.type === 'terminal') {
          throw new TypeError(
            'Terminal authentication is not supported by the control-plane API.',
          );
        }

        await connection.authenticate(methodId);
        return observation(connection);
      },
    );
  }

  private async withConnection<T>(
    definition: AgentDefinition,
    timeoutMs: number,
    operation: (connection: AcpRuntimeConnection) => Promise<T>,
  ): Promise<T> {
    const started = await this.start(definition, timeoutMs);
    try {
      return await operation(started.connection);
    } finally {
      started.connection.close();
      await this.runner.stop(started.handle).catch(() => undefined);
    }
  }

  private async start(
    definition: AgentDefinition,
    timeoutMs: number,
  ): Promise<StartedConnection> {
    const handle = await this.runner.spawn({
      command: definition.runtime.command,
      args: [...definition.runtime.args],
      cwd: definition.runtime.cwd ?? process.cwd(),
      env: environmentFor(definition),
      timeoutMs,
    });

    try {
      const transport = this.runner.transport(handle);
      const stream = acp.ndJsonStream(transport.writable, transport.readable);
      const connection = await this.runtimeFactory().connect(stream);
      return { handle, connection };
    } catch (error) {
      await this.runner.stop(handle).catch(() => undefined);
      throw error;
    }
  }
}
