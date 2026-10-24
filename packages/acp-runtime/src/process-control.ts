import * as acp from '@agentclientprotocol/sdk';
import type { AgentDefinition } from '@control-plane/core';
import type { ProcessHandle, Runner } from '@control-plane/runner';
import { AcpClientRuntime, type AcpRuntimeConnection } from './runtime.js';
import type { AgentReadiness, AgentNegotiation } from './types.js';
import { transientAuthenticationError } from './auth-failure.js';

export type AgentAuthMethodSummary = {
  id: string;
  name: string;
  type?: string | undefined;
};

export type AgentRuntimeObservation = {
  readiness: AgentReadiness;
  authMethods: AgentAuthMethodSummary[];
  negotiation?: AgentNegotiation;
};

export interface AgentRuntimeControl {
  probe(definition: AgentDefinition): Promise<AgentRuntimeObservation>;
  authenticate(definition: AgentDefinition, methodId: string): Promise<AgentRuntimeObservation>;
  close?(): void;
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

const connectionFailures = {
  missing_entry: '找不到程序或启动目录。请检查已安装程序、脚本和启动目录的路径。',
  access_denied: '系统拒绝启动程序。请检查程序的访问权限和系统拦截提示，再重试连接。',
  start_failed: '程序未能启动。请检查本机入口、参数和启动目录，再重试连接。',
  timeout: '等待 ACP 连接超时。请确认程序能够启动，核对 ACP 参数后重试。',
  exited: '程序在完成 ACP 连接前已退出。请确认选择的是 ACP 入口，并检查必需的启动参数。',
  initialize_failed:
    '程序未能完成 ACP 初始化。请核对产品的 ACP 入口和参数；普通聊天或命令行入口可能不支持 ACP。',
  authentication_failed:
    'Agent 的登录确认未完成。请在它自己的登录窗口或应用中检查授权状态，再重试确认。',
  authentication_unavailable: 'Agent 登录服务暂时不可达或确认超时，已有授权未被判定为失效。',
} as const;

/** Fixed public diagnostics only: never expose process output, credentials or raw provider errors. */
export class AgentConnectionFailure extends Error {
  constructor(
    readonly reason: keyof typeof connectionFailures,
    readonly observation?: AgentRuntimeObservation,
  ) {
    super(connectionFailures[reason]);
    this.name = 'AgentConnectionFailure';
  }
}

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
    negotiation: connection.negotiation,
    authMethods: authMethods(connection),
  };
}

export class ProcessAgentRuntimeControl implements AgentRuntimeControl {
  private readonly shutdown = new AbortController();
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
    return this.withConnection(definition, this.authenticationTimeoutMs, async (connection) => {
      const method = connection.authMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new RangeError(`Authentication method not advertised: ${methodId}`);
      }
      if ('type' in method && method.type === 'terminal') {
        throw new TypeError('Terminal authentication is not supported by the control-plane API.');
      }

      try {
        await connection.authenticate(methodId);
      } catch (error) {
        throw new AgentConnectionFailure(
          transientAuthenticationError(error)
            ? 'authentication_unavailable'
            : 'authentication_failed',
          observation(connection),
        );
      }
      return observation(connection);
    });
  }

  close(): void {
    this.shutdown.abort();
  }

  private async withConnection<T>(
    definition: AgentDefinition,
    timeoutMs: number,
    operation: (connection: AcpRuntimeConnection) => Promise<T>,
  ): Promise<T> {
    const started = await this.start(definition, timeoutMs);
    try {
      return await operation(started.connection);
    } catch (error) {
      // Stdout can close before the process close event publishes its terminal
      // state. Wait for runner cleanup before classifying a timeout as bad login.
      const stopped = await this.runner.stop(started.handle).catch(() => undefined);
      if (stopped?.state === 'timed_out')
        throw new AgentConnectionFailure(
          'authentication_unavailable',
          observation(started.connection),
        );
      throw error;
    } finally {
      started.connection.close();
      await this.runner.stop(started.handle).catch(() => undefined);
    }
  }

  private async start(definition: AgentDefinition, timeoutMs: number): Promise<StartedConnection> {
    let handle: ProcessHandle;
    try {
      handle = await this.runner.spawn({
        agentId: definition.id,
        command: definition.runtime.command,
        args: [...definition.runtime.args],
        cwd: definition.runtime.cwd ?? process.cwd(),
        env: environmentFor(definition),
        timeoutMs,
        signal: this.shutdown.signal,
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new AgentConnectionFailure(
        code === 'ENOENT'
          ? 'missing_entry'
          : code === 'EACCES' || code === 'EPERM'
            ? 'access_denied'
            : 'start_failed',
      );
    }

    try {
      const transport = this.runner.transport(handle);
      const stream = acp.ndJsonStream(transport.writable, transport.readable);
      const connection = await this.runtimeFactory().connect(stream);
      return { handle, connection };
    } catch {
      let beforeStop;
      try {
        beforeStop = this.runner.status(handle);
      } catch {
        /* Still release the process. */
      }
      const stopped = await this.runner.stop(handle).catch(() => undefined);
      throw new AgentConnectionFailure(
        beforeStop?.state === 'timed_out' || stopped?.state === 'timed_out'
          ? 'timeout'
          : ['exited', 'failed'].includes(beforeStop?.state ?? '')
            ? 'exited'
            : 'initialize_failed',
      );
    }
  }
}
