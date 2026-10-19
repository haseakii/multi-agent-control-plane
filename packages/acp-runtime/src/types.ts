export type AgentId = string;

export type AgentCapability = {
  name: string;
  source: 'configured' | 'advertised' | 'verified';
};

export type AcpStdioRuntimeDefinition = {
  type: 'acp-stdio';
  command: string;
  args: string[];
  cwd?: string;
  environmentAllowlist?: string[];
};

export type AgentDefinition = {
  id: AgentId;
  name: string;
  description?: string;
  enabled: boolean;
  runtime: AcpStdioRuntimeDefinition;
  capabilities: AgentCapability[];
  auth: {
    mode: 'agent-managed' | 'secret-ref';
    secretRef?: string;
  };
};

export type RuntimeHealth = 'unknown' | 'ready' | 'error';
export type AuthReadiness = 'unknown' | 'needs_login' | 'ready' | 'not_reported';

export type AgentReadiness = {
  runtime: RuntimeHealth;
  auth: AuthReadiness;
  observedAt: string;
  authMethodIds: string[];
};

export type PermissionRequest = {
  sessionId: string;
  options: Array<{
    optionId: string;
    name: string;
    kind?: string;
  }>;
  subject: unknown;
};

export type PermissionDecision =
  | {
      outcome: 'cancelled';
    }
  | {
      outcome: 'selected';
      optionId: string;
    };

export interface PermissionBroker {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export type AgentEvent =
  | {
      type: 'text_delta';
      sessionId: string;
      text: string;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      optionIds: string[];
    }
  | {
      type: 'tool';
      sessionId: string;
      updateType: string;
      payload: unknown;
    }
  | {
      type: 'status';
      sessionId: string;
      updateType: string;
      payload: unknown;
    }
  | {
      type: 'completed';
      sessionId: string;
      stopReason: string;
    };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export type NewSessionInput = {
  cwd: string;
  mcpServers?: unknown[];
};

export type SessionRef = {
  sessionId: string;
};
