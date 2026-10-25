import { z } from 'zod';
import { fetchJSON, fetchExternalText, postJSON, putJSON } from '@/lib/transport';
import { resumeRequest } from './task-request';
import type { ChatMessage } from '@/components/chat/chat-types';
import type { SubagentProgress } from '@/stores/subagents';
import type { WorkspaceConfirmation } from './workspace-api';
import { submitDraft, type DraftSubmission } from './draft-submission';
import { agentActivity } from './agent-activity';
import { attemptNotices, executionEnded, toolPresentation } from './activity-presentation';
import { failureSummary } from './failure-presentation';
import { selectableAgents, type ExecutionMode } from './agent-selection';
import { InputAttachment, attachmentText, type InputAttachmentData } from './input-attachments';

const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  objective: z.string(),
  state: z.string(),
  parentTaskId: z.string().optional(),
  ownerAgentId: z.string().optional(),
  resultArtifactRefs: z.array(z.string()),
  dependencyIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const Snapshot = z.object({
  inputAttachments: z
    .array(
      z.object({ taskId: z.string(), ownerId: z.string(), attachments: z.array(InputAttachment) }),
    )
    .default([]),
  generatedAt: z.string(),
  timelineScope: z.string().nullable().optional(),
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), defaultBossAgentId: z.string().optional() }),
  ),
  agents: z.array(
    z.object({
      definition: z.object({
        id: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        orchestration: z.object({ canBeBoss: z.boolean() }),
        controlBridge: z.object({ transport: z.string(), scopes: z.array(z.string()) }),
      }),
      readiness: z.object({ runtime: z.string(), auth: z.string() }),
    }),
  ),
  tasks: z.array(Task),
  assignments: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      state: z.string(),
      attempt: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  executionAttempts: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        assignmentId: z.string(),
        number: z.number().int(),
        state: z.string(),
        failure: z
          .object({ code: z.string().optional(), message: z.string(), retryable: z.boolean() })
          .optional(),
        createdAt: z.string().optional(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
      }),
    )
    .default([]),
  workspaceCleanups: z.array(z.object({ taskId: z.string() })).default([]),
  workspaces: z.array(z.object({ id: z.string(), rootPath: z.string() })).default([]),
  assignmentWorkspaces: z
    .array(z.object({ taskId: z.string(), workspaceId: z.string(), mode: z.string() }))
    .default([]),
  timeline: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      taskId: z.string().optional(),
      type: z.string(),
      occurredAt: z.string(),
      payload: z.unknown().optional(),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string(),
      taskId: z.string().optional(),
      assignmentId: z.string().optional(),
      producerAgentId: z.string().optional(),
      kind: z.string().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mimeType: z.string(),
      name: z.string().optional(),
      createdAt: z.string().optional(),
    }),
  ),
  approvals: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      taskId: z.string().optional(),
      state: z.string(),
      action: z.string(),
      resource: z.unknown(),
      enforcementMode: z.string(),
      boundary: z.string().optional(),
      acp: z
        .object({
          review: z.object({
            tool: z.string().max(1024).nullable(),
            action: z.string().max(1024).nullable(),
            target: z.string().max(1024).nullable(),
          }),
        })
        .optional(),
      decisionEligibility: z.object({
        canApprove: z.boolean(),
        canReject: z.boolean(),
        reason: z.string(),
        checkedAt: z.string(),
        validForMs: z.number(),
      }),
    }),
  ),
});
export type SnapshotData = z.infer<typeof Snapshot>;
export type TaskData = z.infer<typeof Task>;
/** Presentation hint only. The mutation route remains authoritative. */
export function canResumeTask(snapshot: SnapshotData, task: TaskData): boolean {
  if (!['failed', 'waiting', 'blocked', 'ready'].includes(task.state)) return false;
  if (
    snapshot.timeline.some(
      (event) =>
        event.type === 'task.followup.created' &&
        typeof event.payload === 'object' &&
        event.payload !== null &&
        'sourceTaskId' in event.payload &&
        event.payload.sourceTaskId === task.id,
    )
  )
    return false;
  if (snapshot.workspaceCleanups.some((item) => item.taskId === task.id)) return false;
  if (
    snapshot.executionAttempts.some(
      (item) => item.taskId === task.id && ['queued', 'running', 'waiting'].includes(item.state),
    )
  )
    return false;
  const assignment = snapshot.assignments.filter((item) => item.taskId === task.id).at(-1);
  if (!assignment) return false;
  const attempt = snapshot.executionAttempts
    .filter((item) => item.assignmentId === assignment.id)
    .sort((a, b) => b.number - a.number)[0];
  return (
    !!attempt &&
    ['failed', 'interrupted'].includes(attempt.state) &&
    attempt.number === assignment.attempt &&
    attempt.failure?.retryable !== false &&
    snapshot.agents.some(
      (agent) => agent.definition.id === assignment.agentId && agent.definition.enabled,
    ) &&
    task.dependencyIds.every((id) =>
      snapshot.tasks.some(
        (dependency) =>
          dependency.id === id &&
          dependency.projectId === task.projectId &&
          dependency.state === 'completed',
      ),
    )
  );
}
export const terminal = (task: TaskData) =>
  ['completed', 'failed', 'cancelled'].includes(task.state);
export const stateLabel = (state: string) =>
  (
    ({
      draft: '草稿',
      ready: '准备执行',
      created: '待启动',
      pending: '待启动',
      queued: '排队中',
      assigned: '已分派',
      running: '执行中',
      waiting_children: '等待协作结果',
      waiting_approval: '等待确认',
      waiting: '等待协作结果',
      blocked: '等待处理',
      completed: '已完成',
      failed: '失败',
      cancelled: '已停止',
    }) as Record<string, string>
  )[state] ?? state;
export function eligibleBosses(snapshot: SnapshotData) {
  return selectableAgents(snapshot.agents, 'collaborative');
}
export const eligibleAgents = (snapshot: SnapshotData, mode: ExecutionMode) =>
  selectableAgents(snapshot.agents, mode);
export const readSnapshot = (signal?: AbortSignal) =>
  fetchJSON('/api/control-center', { signal }, Snapshot);
export const readConversationSnapshot = (taskId: string | null, signal?: AbortSignal) =>
  fetchJSON(
    `/api/control-center?view=conversation${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ''}`,
    { signal },
    Snapshot,
  );
const WorkbenchInfo = z.object({
  mode: z.enum(['mock', 'real']),
  profile: z.enum(['daily', 'acceptance']).optional(),
  promptsUsed: z.number().int().nonnegative().optional(),
  uiBuildId: z.string().optional(),
});
export type WorkbenchData = z.infer<typeof WorkbenchInfo>;
export const readWorkbench = (signal?: AbortSignal) =>
  fetchJSON('/api/workbench', { signal }, WorkbenchInfo);
const Instruction = z.object({
  id: z.string(),
  taskId: z.string(),
  content: z.string(),
  state: z.enum(['queued', 'claimed', 'delivered']),
  createdAt: z.string(),
});
export type InstructionData = z.infer<typeof Instruction>;
export const readInstructions = (id: string, signal?: AbortSignal) =>
  fetchJSON(
    `/api/tasks/${encodeURIComponent(id)}/instructions`,
    signal ? { signal } : undefined,
    z.object({ instructions: z.array(Instruction), canSubmit: z.boolean(), reason: z.string() }),
  );
export const sendInstruction = (id: string, content: string, idempotencyKey: string) =>
  postJSON(
    `/api/tasks/${encodeURIComponent(id)}/instructions`,
    { content, idempotencyKey },
    z.object({ instruction: Instruction }),
  );
export const sendFollowUp = (id: string, content: string, idempotencyKey: string) =>
  postJSON(
    `/api/tasks/${encodeURIComponent(id)}/follow-ups`,
    { content, idempotencyKey },
    z.object({ task: Task, reused: z.boolean() }),
  );
export const sendChat = (
  id: string,
  content: string,
  idempotencyKey: string,
  workspaceConfirmation?: WorkspaceConfirmation,
  sessionSettings?: Record<string, string>,
  attachmentIds?: string[],
) =>
  postJSON(
    `/api/tasks/${encodeURIComponent(id)}/chat`,
    { content, idempotencyKey, workspaceConfirmation, sessionSettings, attachmentIds },
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('instruction'), instruction: Instruction }),
      z.object({ kind: z.literal('followup'), task: Task }),
    ]),
  );

export const readChatReceipt = (id: string, key: string) =>
  fetchJSON(
    `/api/tasks/${encodeURIComponent(id)}/chat-receipts/${encodeURIComponent(key)}`,
    undefined,
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('missing') }),
      z.object({ kind: z.literal('instruction'), instruction: Instruction }),
      z.object({ kind: z.literal('followup'), task: Task }),
    ]),
  );

const FollowUpLink = z.object({ sourceTaskId: z.string(), conversationRootTaskId: z.string() });
function followUpLinks(snapshot: SnapshotData) {
  return snapshot.timeline
    .filter((e) => e.type === 'task.followup.created' && e.taskId)
    .map((e) => ({
      taskId: e.taskId!,
      ...FollowUpLink.parse(e.payload),
    }));
}
export function conversationRounds(snapshot: SnapshotData, taskId: string): TaskData[] {
  const links = followUpLinks(snapshot);
  const first = links.find((l) => l.taskId === taskId)?.conversationRootTaskId ?? taskId;
  const ids = new Set([
    first,
    ...links.filter((l) => l.conversationRootTaskId === first).map((l) => l.taskId),
  ]);
  return snapshot.tasks
    .filter((t) => ids.has(t.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function conversationList(snapshot: SnapshotData): TaskData[] {
  const continuations = new Set(followUpLinks(snapshot).map((l) => l.taskId));
  return snapshot.tasks
    .filter((t) => !t.parentTaskId && !continuations.has(t.id))
    .map((t) => {
      const latest = conversationRounds(snapshot, t.id).at(-1)!;
      return { ...t, state: latest.state, updatedAt: latest.updatedAt };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function conversationMessages(
  rounds: TaskData[],
  content: Record<string, string>,
  instructions: InstructionData[],
  artifacts: SnapshotData['artifacts'] = [],
  snapshot?: SnapshotData,
): ChatMessage[] {
  const activity = snapshot
    ? agentActivity(
        snapshot.timeline,
        rounds.flatMap((r) => taskFamily(snapshot, r).map((t) => t.id)),
      )
    : [];
  const progressMessages = activity.flatMap<ChatMessage>((entry) => {
    const task = snapshot?.tasks.find((t) => t.id === entry.taskId);
    const attempt = snapshot?.executionAttempts.find((a) => a.id === entry.attemptId);
    const attemptEnded = executionEnded(attempt?.state, task?.state);
    const name =
      snapshot?.agents.find((a) => a.definition.id === entry.agentId)?.definition.name ??
      entry.agentId;
    const resultHashes = (task?.resultArtifactRefs ?? []).map(
      (id) => artifacts.find((a) => a.id === id)?.sha256,
    );
    const transcriptHash = artifacts.find((a) => a.id === entry.artifactId)?.sha256;
    // The final result already has its own chat bubble; preserve earlier plans
    // and worker dialogue, without repeating the same final assistant output.
    if (
      entry.kind === 'message' &&
      rounds.some((r) => r.id === entry.taskId) &&
      transcriptHash &&
      resultHashes.includes(transcriptHash)
    )
      return [];
    const status =
      entry.kind === 'tool'
        ? ({ pending: '等待执行', in_progress: '执行中', completed: '已完成', failed: '失败' }[
            entry.state
          ] ?? '已记录')
        : entry.state === 'streaming' && task && !attemptEnded
          ? '正在回复'
          : entry.state === 'interrupted'
            ? '回复中断，记录已保留'
            : '进展记录';
    const display = entry.text;
    if (entry.kind === 'tool') {
      const {
        label,
        outcome,
        status: toolStatus,
      } = toolPresentation(entry.text, entry.state, attempt?.state, task?.state);
      if (outcome === 'awaiting_report')
        return [
          {
            id: entry.id,
            role: 'system',
            createdAt: entry.at,
            status: 'complete',
            text: `${name} · ${label} · ${toolStatus}。成员可能已进入后续步骤；最终结果会自动更新。`,
          },
        ];
      if (outcome === 'unreported')
        return [
          {
            id: entry.id,
            role: 'system',
            createdAt: entry.at,
            status: 'complete',
            text: `${name} · ${label} · 本次执行已结束，工具未上报最终结果（结果未知）。`,
          },
        ];
      return [
        {
          id: entry.id,
          role: 'tool',
          createdAt: entry.at,
          status: 'complete',
          tools: [
            {
              tool_id: entry.id,
              name: label,
              context: `${name} · ${toolStatus}`,
              status: outcome,
              startedAt: entry.at,
            },
          ],
        },
      ];
    }
    return [
      {
        id: entry.id,
        role: 'assistant',
        createdAt: entry.at,
        text: `**${name} · ${status}**\n\n${display}${entry.truncated ? '\n\n（此处为预览，完整内容见下方记录）' : ''}${entry.artifactId ? `\n\n[查看完整回复](${artifactUrl(entry.artifactId)})` : ''}`,
        status:
          entry.state === 'streaming' && task && !attemptEnded
            ? 'streaming'
            : entry.state === 'interrupted'
              ? 'error'
              : 'complete',
      },
    ];
  });
  const family = snapshot ? rounds.flatMap((r) => taskFamily(snapshot, r)) : [];
  const familyIds = new Set(family.map((task) => task.id));
  const attempts = snapshot?.executionAttempts.filter((a) => familyIds.has(a.taskId)) ?? [];
  const notices = attempts.flatMap((attempt) => {
    const agentId = snapshot?.assignments.find((a) => a.id === attempt.assignmentId)?.agentId;
    const name =
      snapshot?.agents.find((a) => a.definition.id === agentId)?.definition.name ?? '成员';
    return attemptNotices([attempt], name);
  });
  const failuresShown = new Set(
    attempts
      .filter((a) => notices.some((n) => n.id === `attempt-ended-${a.id}`))
      .map((a) => a.taskId),
  );
  return rounds
    .flatMap((task) => [
      ...toMessages(
        task,
        content,
        artifacts,
        snapshot?.executionAttempts
          .filter((a) => a.taskId === task.id)
          .sort((a, b) => b.number - a.number)[0],
        snapshot?.inputAttachments.find((item) => item.ownerId === task.id)?.attachments,
      ),
      ...instructions
        .filter((i) => i.taskId === task.id)
        .map(
          (i): ChatMessage => ({
            id: i.id,
            role: 'user',
            createdAt: Date.parse(i.createdAt),
            text:
              i.content +
              attachmentText(
                snapshot?.inputAttachments.find((item) => item.ownerId === i.id)?.attachments ?? [],
              ),
            status: 'complete',
          }),
        ),
    ])
    .filter(
      (message) =>
        !rounds.some((task) => failuresShown.has(task.id) && message.id === `failed-${task.id}`),
    )
    .concat(progressMessages, notices)
    .sort((a, b) => a.createdAt - b.createdAt);
}
export const artifactUrl = (id: string) => `/api/artifacts/${encodeURIComponent(id)}/content`;
export const readArtifact = (id: string, signal?: AbortSignal) =>
  fetchExternalText(artifactUrl(id), { signal });
export function taskAgentName(snapshot: SnapshotData, task: TaskData) {
  const id =
    task.ownerAgentId ??
    snapshot.assignments
      .filter((a) => a.taskId === task.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.agentId;
  return snapshot.agents.find((a) => a.definition.id === id)?.definition.name;
}

// Reuse and reconcile the durable draft on retry. The engine fixes the execution
// target at start and rejects starting the same durable draft twice.
export type Submission = DraftSubmission;
export async function startTask(
  objective: string,
  bossId: string,
  submission: Submission,
  workspaceConfirmation?: WorkspaceConfirmation,
  mode: ExecutionMode = 'collaborative',
  onChanged: () => void = () => {},
): Promise<TaskData> {
  const goal = z.string().trim().min(1).max(100000).parse(objective);
  const Record = z.object({
    task: Task,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    canEditObjective: z.boolean(),
    reason: z.string(),
  });
  return submitDraft(
    goal,
    submission,
    {
      create: (projectId, objective, idempotencyKey) =>
        postJSON(
          `/api/projects/${encodeURIComponent(projectId)}/tasks`,
          {
            title: objective.slice(0, 70),
            objective,
            idempotencyKey,
            attachmentIds: submission.creationAttachmentIds ?? submission.attachmentIds,
          },
          Task,
        ),
      read: (taskId) =>
        fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/record`, undefined, Record),
      update: (taskId, objective, version) =>
        fetchJSON(
          `/api/tasks/${encodeURIComponent(taskId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: objective.slice(0, 70), objective, version }),
          },
          Record,
        ),
      ...(mode === 'collaborative'
        ? {
            selectBoss: (projectId: string) =>
              putJSON(
                `/api/projects/${encodeURIComponent(projectId)}/boss`,
                { agentId: bossId },
                z.unknown(),
              ),
          }
        : {}),
      start: async (taskId, version) => {
        const result = await postJSON(
          `/api/tasks/${encodeURIComponent(taskId)}/start`,
          {
            version,
            ...(mode === 'direct' ? { mode, agentId: bossId } : { bossAgentId: bossId }),
            workspaceConfirmation,
            sessionSettings: submission.sessionSettings,
            attachmentIds: submission.attachmentIds,
          },
          z.object({ task: Task }),
        );
        return result.task;
      },
    },
    onChanged,
  );
}
export async function createWorkItem(objective: string, projectId: string) {
  return postJSON(
    '/api/projects',
    { id: projectId, name: objective.trim().slice(0, 70), workspace: { kind: 'managed' } },
    z.object({ id: z.string() }),
  );
}
export const cancelTask = (id: string) =>
  postJSON(`/api/tasks/${encodeURIComponent(id)}/cancel`, {}, z.unknown());
export const resumeTask = (id: string, workspaceConfirmation?: WorkspaceConfirmation) =>
  resumeRequest((signal) =>
    fetchJSON(
      `/api/tasks/${encodeURIComponent(id)}/resume`,
      { method: 'POST', body: JSON.stringify({ workspaceConfirmation }), signal },
      z.unknown(),
    ),
  );
export const decideApproval = (id: string, action: 'approve' | 'reject') =>
  postJSON(
    `/api/approvals/${encodeURIComponent(id)}/${action}`,
    { actor: 'hermes-workbench-user' },
    z.unknown(),
  );

export function taskFamily(snapshot: SnapshotData, root: TaskData) {
  const ids = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of snapshot.tasks)
      if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
        ids.add(task.id);
        changed = true;
      }
  }
  return snapshot.tasks
    .filter((t) => ids.has(t.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function conversationArtifactIds(task: TaskData, artifacts: SnapshotData['artifacts']) {
  return task.resultArtifactRefs.filter((id) => {
    const artifact = artifacts.find((item) => item.id === id);
    // The engine publishes worktree patches/manifests without an Agent producer.
    // Agent-published JSON (and other user results) keeps its producer and remains visible.
    const workspaceMaterial =
      artifact?.assignmentId &&
      !artifact.producerAgentId &&
      ((artifact.kind === 'diff' && artifact.mimeType === 'text/x-diff') ||
        (artifact.kind === 'json' && artifact.mimeType === 'application/json'));
    return !workspaceMaterial;
  });
}
export function toMessages(
  root: TaskData,
  content: Record<string, string>,
  artifacts: SnapshotData['artifacts'] = [],
  attempt?: { failure?: { message: string; code?: string }; finishedAt?: string },
  attachments: InputAttachmentData[] = [],
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      id: `goal-${root.id}`,
      role: 'user',
      createdAt: Date.parse(root.createdAt),
      text: root.objective + attachmentText(attachments),
      status: 'complete',
    },
  ];
  for (const id of conversationArtifactIds(root, artifacts))
    if (content[id] !== undefined)
      messages.push({
        id: `result-${id}`,
        role: 'assistant',
        createdAt: Date.parse(
          artifacts.find((item) => item.id === id)?.createdAt ?? root.updatedAt,
        ),
        text: content[id],
        status: root.state === 'failed' ? 'error' : 'complete',
      });
  if (root.state === 'failed')
    messages.push({
      id: `failed-${root.id}`,
      role: 'system',
      createdAt: Date.parse(attempt?.finishedAt ?? root.updatedAt),
      text: failureSummary(attempt?.failure?.message, attempt?.failure?.code),
      status: 'error',
    });
  if (root.state === 'cancelled')
    messages.push({
      id: `cancelled-${root.id}`,
      role: 'system',
      createdAt: Date.parse(root.updatedAt),
      text: '任务已停止。历史记录和已有结果仍然保留。',
      status: 'complete',
    });
  return messages;
}
export function toSubagents(
  snapshot: SnapshotData,
  root: TaskData,
  content: Record<string, string>,
): SubagentProgress[] {
  return taskFamily(snapshot, root)
    .filter((t) => t.id !== root.id)
    .map((task, index) => ({
      id: task.id,
      parentId: task.parentTaskId === root.id ? null : (task.parentTaskId ?? null),
      goal: task.title,
      model: taskAgentName(snapshot, task),
      status:
        task.state === 'completed'
          ? 'completed'
          : task.state === 'failed'
            ? 'failed'
            : task.state === 'cancelled'
              ? 'interrupted'
              : task.state === 'running'
                ? 'running'
                : 'queued',
      taskCount: 1,
      taskIndex: index,
      startedAt: Date.parse(task.createdAt),
      updatedAt: Date.parse(task.updatedAt),
      durationSeconds: terminal(task)
        ? Math.max(0, (Date.parse(task.updatedAt) - Date.parse(task.createdAt)) / 1000)
        : undefined,
      filesRead: [],
      filesWritten: [],
      stream: agentActivity(snapshot.timeline, [task.id]).map((entry) => {
        const attempt = snapshot.executionAttempts.find((a) => a.id === entry.attemptId);
        const tool = toolPresentation(entry.text, entry.state, attempt?.state, task.state);
        return {
          at: entry.at,
          kind: entry.kind === 'tool' ? ('tool' as const) : ('progress' as const),
          text: entry.kind === 'tool' ? `${tool.label} · ${tool.status}` : entry.text,
          isError: ['failed', 'interrupted'].includes(entry.state),
        };
      }),
      summary:
        conversationArtifactIds(task, snapshot.artifacts)
          .map((id) => content[id])
          .filter(Boolean)
          .join('\n') || stateLabel(task.state),
    }));
}
