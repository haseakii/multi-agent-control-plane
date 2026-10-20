import type {
  AgentDefinition,
  AgentId,
  Artifact,
  BridgeScope,
  Task,
} from '@control-plane/core';

export type FleetBridgeIdentity = {
  agentId: AgentId;
  projectId: string;
  sessionId: string;
  taskId?: string;
};

export type FleetToolOperation =
  | 'agents.discover'
  | 'tasks.create'
  | 'tasks.delegate'
  | 'tasks.read'
  | 'tasks.wait'
  | 'messages.send'
  | 'tasks.cancel'
  | 'artifacts.read'
  | 'artifacts.publish'
  | 'approvals.request';

export type FleetCallContext = {
  identity: FleetBridgeIdentity;
  agent: AgentDefinition;
  toolName: string;
  operation: FleetToolOperation;
};

export type FleetAuthorizationRequest = FleetCallContext & {
  input: unknown;
};

export type FleetAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type FleetAuditOutcome = 'succeeded' | 'failed' | 'denied';

export type FleetAuditRecord = FleetCallContext & {
  input: unknown;
  outcome: FleetAuditOutcome;
  reason?: string;
};

export type DiscoverAgentsInput = {
  exact?: string[];
  prefixes?: string[];
  custom?: string;
  limit?: number;
};

export type CreateTaskInput = {
  title: string;
  objective: string;
  parentTaskId?: string;
  dependencyIds?: string[];
  contextRefs?: string[];
};

export type DelegateTaskInput = {
  taskId: string;
  agentId: string;
  objective?: string;
  role?: {
    name: string;
    description?: string;
  };
};

export type SendMessageInput = {
  targetAgentId: string;
  taskId?: string;
  type: 'request' | 'response' | 'message' | 'handoff' | 'event' | 'status';
  content?: string;
  artifactRefs?: string[];
};

export type PublishArtifactInput = {
  taskId?: string;
  kind:
    | 'plan'
    | 'report'
    | 'patch'
    | 'diff'
    | 'log'
    | 'image'
    | 'test-report'
    | 'file'
    | 'directory-manifest'
    | 'json'
    | 'text';
  mimeType: string;
  content: string;
};

export type RequestApprovalInput = {
  taskId?: string;
  action: string;
  resource: Record<string, unknown>;
};

export interface FleetControlServices {
  discoverAgents(input: DiscoverAgentsInput, context: FleetCallContext): Promise<unknown>;
  getAgent(input: { agentId: string }, context: FleetCallContext): Promise<AgentDefinition | unknown>;
  createTask(input: CreateTaskInput, context: FleetCallContext): Promise<Task | unknown>;
  delegateTask(input: DelegateTaskInput, context: FleetCallContext): Promise<unknown>;
  getTask(input: { taskId: string }, context: FleetCallContext): Promise<Task | unknown>;
  waitTask(
    input: { taskId: string; timeoutMs?: number },
    context: FleetCallContext,
  ): Promise<Task | unknown>;
  sendMessage(input: SendMessageInput, context: FleetCallContext): Promise<unknown>;
  publishArtifact(input: PublishArtifactInput, context: FleetCallContext): Promise<Artifact | unknown>;
  getArtifact(input: { artifactId: string }, context: FleetCallContext): Promise<Artifact | unknown>;
  requestApproval(input: RequestApprovalInput, context: FleetCallContext): Promise<unknown>;
  cancelTask(input: { taskId: string }, context: FleetCallContext): Promise<Task | unknown>;
}

export type FleetBridgeHooks = {
  authorize(request: FleetAuthorizationRequest): Promise<FleetAuthorizationDecision>;
  audit(record: FleetAuditRecord): Promise<void>;
};

export type FleetMcpServerOptions = {
  identity: FleetBridgeIdentity;
  agent: AgentDefinition;
  services: FleetControlServices;
  hooks: FleetBridgeHooks;
  name?: string;
  version?: string;
};

export type FleetToolDefinition = {
  name: string;
  operation: FleetToolOperation;
  anyScope: BridgeScope[];
};
