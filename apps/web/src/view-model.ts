import type {
  AcpPermissionReview,
  ApprovalDecisionEligibility,
} from '../../../packages/core/src/domain';
import type { MessageDeliveryView } from '../../../packages/core/src/message-delivery-view';

export type AuthMethod = { id: string; name: string; type?: string };
export type Project = { id: string; name: string; defaultBossAgentId?: string };
export type Task = {
  id: string;
  projectId: string;
  parentTaskId?: string;
  title: string;
  objective: string;
  state: string;
  ownerAgentId?: string;
  dependencyIds?: string[];
  resultArtifactRefs: string[];
};
export type Artifact = {
  id: string;
  projectId: string;
  taskId?: string;
  kind: string;
  producerAgentId?: string;
  sizeBytes: number;
  mimeType: string;
};
export type Attempt = {
  id: string;
  taskId: string;
  assignmentId: string;
  number: number;
  state: string;
  failure?: { retryable: boolean; code: string; message: string };
};
export type TimelineEvent = {
  id: string;
  projectId: string;
  taskId?: string;
  type: string;
  occurredAt: string;
  actor: { id: string; type?: string };
  payload?: Record<string, unknown>;
};
export type Snapshot = {
  generatedAt: string;
  projects: Project[];
  agents: Array<{
    definition: {
      id: string;
      name: string;
      enabled: boolean;
      runtime: { command: string; args: string[]; cwd?: string; environmentAllowlist?: string[] };
      orchestration: { canBeBoss: boolean };
      controlBridge: { transport: string; scopes: string[] };
      capabilities: Array<{ name: string; source: string }>;
    };
    readiness: { runtime: string; auth: string; observedAt?: string };
    negotiation?: {
      protocolVersion: number;
      agentInfo: Record<string, unknown> | null;
      agentCapabilities: Record<string, unknown>;
      authMethods: unknown[];
      note: string;
    };
    localEntry?: { offlineChecksPassed: boolean; issues: Array<{ code: string; message: string }> };
    authMethods: AuthMethod[];
    error?: string;
  }>;
  tasks: Task[];
  assignments?: Array<{
    id: string;
    taskId: string;
    agentId: string;
    attempt: number;
    state?: string;
  }>;
  executionAttempts?: Attempt[];
  timeline: TimelineEvent[];
  messages: Array<{
    id: string;
    projectId: string;
    taskId?: string;
    fromAgentId: string;
    toAgentId?: string;
    type: string;
    content?: string;
    correlationId?: string;
    replyTo?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    createdAt: string;
  }>;
  messageDeliveries?: MessageDeliveryView[];
  approvals: Array<{
    id: string;
    projectId: string;
    taskId?: string;
    requesterAgentId?: string;
    action: string;
    resource: Record<string, unknown>;
    state: string;
    enforcementMode: string;
    boundary?: string;
    assignmentId?: string;
    expiryReason?: string;
    decisionEligibility?: ApprovalDecisionEligibility;
    acp?: {
      review: AcpPermissionReview;
      attemptId: string;
      attemptNumber: number;
      expiresAt: string;
    };
  }>;
  approvalReadDiagnostics?: { code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED'; count: number };
  artifacts: Artifact[];
  runners: Array<{ id: string; kind: string; status: string }>;
  workspaces: Array<{
    id: string;
    projectId: string;
    provider: string;
    access: string;
    rootPath?: string;
    branchName?: string;
    baseRevision?: string;
  }>;
  workspaceConfigs?: Array<{
    id: string;
    sourceWorkspaceId: string;
    mode: string;
    updatedAt: string;
  }>;
  assignmentWorkspaces?: Array<{
    id: string;
    projectId: string;
    taskId: string;
    workspaceId: string;
    sourceWorkspaceId: string;
    mode: string;
  }>;
  workspaceCleanups?: Array<{
    id: string;
    taskId: string;
    state: 'removing' | 'completed' | 'failed';
  }>;
  directoryBindings?: Array<{
    id: string;
    projectId: string;
    rootPath: string;
    confirmationVersion?: string;
  }>;
};

export function taskFamily(tasks: Task[], taskId: string): Set<string> {
  const ids = new Set([taskId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const task of tasks) {
      if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
        ids.add(task.id);
        changed = true;
      }
    }
  }
  return ids;
}

/** A snapshot hint, never authorization: mutation routes recheck current state. */
export function taskActionEligibility(task: Task, snapshot: Snapshot) {
  const canCancel = [
    'draft',
    'planning',
    'ready',
    'running',
    'waiting',
    'waiting_approval',
    'blocked',
  ].includes(task.state);
  const noResume = (reason: string) => ({ canCancel, canResume: false, reason });
  if (snapshot.workspaceCleanups?.some((item) => item.taskId === task.id))
    return noResume('任务工作区已进入清理流程，请创建新任务继续工作。');
  if (['completed', 'cancelled'].includes(task.state)) return noResume('This task is terminal.');
  const assignment = snapshot.assignments?.filter((item) => item.taskId === task.id).at(-1);
  const attempts = snapshot.executionAttempts;
  if (!assignment || !attempts)
    return noResume('Recovery eligibility is not available in this snapshot.');
  if (
    attempts.some(
      (item) => item.taskId === task.id && ['queued', 'running', 'waiting'].includes(item.state),
    )
  ) {
    return noResume('An execution is still active.');
  }
  const latest = attempts
    .filter((item) => item.assignmentId === assignment.id)
    .sort((a, b) => b.number - a.number)[0];
  if (
    !latest ||
    !['failed', 'interrupted'].includes(latest.state) ||
    assignment.attempt !== latest.number
  ) {
    return noResume('The latest execution is not recoverable.');
  }
  if (latest.failure?.retryable === false)
    return noResume('The latest execution is marked non-retryable.');
  if (!['failed', 'waiting', 'blocked', 'ready'].includes(task.state))
    return noResume('Task state does not allow recovery.');
  if (
    !snapshot.agents.some(
      (agent) => agent.definition.id === assignment.agentId && agent.definition.enabled,
    )
  ) {
    return noResume('The assigned agent is unavailable.');
  }
  if (
    (task.dependencyIds ?? []).some(
      (id) =>
        !snapshot.tasks.some(
          (dependency) =>
            dependency.id === id &&
            dependency.projectId === task.projectId &&
            dependency.state === 'completed',
        ),
    )
  ) {
    return noResume('Dependencies must complete first.');
  }
  return {
    canCancel,
    canResume: true,
    reason: 'Creates a new execution attempt from saved context. The server rechecks eligibility.',
  };
}

export function isRoutineEvent(event: TimelineEvent): boolean {
  if (/failed|denied|approval|cancel|interrupt/.test(event.type)) return false;
  if (['failed', 'denied'].includes(String(event.payload?.outcome))) return false;
  return event.type === 'fleet.tool' || /^message\.(queued|claimed|delivered)$/.test(event.type);
}

/** Agent label projection, shared by all task surfaces. */
export function taskAgentId(task: Task, snapshot: Snapshot): string | undefined {
  // Assignment waiting can survive restart after its attempt was interrupted.
  // Only an active execution proves current work; otherwise show the latest
  // assignment in repository insertion order as historical context.
  const assignments = snapshot.assignments?.filter((item) => item.taskId === task.id) ?? [];
  const activeAttempt = snapshot.executionAttempts
    ?.filter(
      (attempt) =>
        attempt.taskId === task.id && ['queued', 'running', 'waiting'].includes(attempt.state),
    )
    .at(-1);
  return (
    assignments.find((assignment) => assignment.id === activeAttempt?.assignmentId) ??
    assignments.at(-1)
  )?.agentId;
}

export type RoutedMessage = Snapshot['messages'][number];

export function messageInTaskScope(
  message: RoutedMessage,
  projectId: string | undefined,
  family: ReadonlySet<string>,
): boolean {
  if (message.projectId !== projectId) return false;
  const metadata = message.metadata && !Array.isArray(message.metadata) ? message.metadata : {};
  const tasks = [
    message.taskId,
    metadata.senderTaskId,
    metadata.recipientTaskId,
    metadata.parentTaskId,
  ].filter((value): value is string => typeof value === 'string');
  return tasks.length === 0 || tasks.some((id) => family.has(id));
}

export function messageResponse(
  request: RoutedMessage,
  messages: readonly RoutedMessage[],
): RoutedMessage | undefined {
  return messages.find(
    (message) =>
      message.projectId === request.projectId &&
      message.type === 'response' &&
      message.replyTo === request.id &&
      message.fromAgentId === request.toAgentId &&
      message.toAgentId === request.fromAgentId,
  );
}
