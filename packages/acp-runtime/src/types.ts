export type {
  AgentDefinition,
  AgentId,
  Capability as AgentCapability,
  AcpStdioRuntimeDefinition,
} from '@control-plane/core';

export type AgentNegotiation = {
  protocolVersion: number;
  agentInfo: Record<string, unknown> | null;
  agentCapabilities: Record<string, unknown>;
  authMethods: unknown[];
  note: string;
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
  review?: import('@control-plane/core').AcpPermissionReview;
  requestId?: string;
  signal?: AbortSignal;
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
      usage?: import('./usage.js').PromptUsage;
    };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export type NewSessionInput = {
  cwd: string;
  mcpServers?: unknown[];
};

export type SessionRef = {
  sessionId: string;
  settings?: import('@control-plane/core').SessionSettingsSnapshot;
};
export type PromptAttachment =
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string; size: number };
