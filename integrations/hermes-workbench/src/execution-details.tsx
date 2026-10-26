import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { z } from 'zod';
import { fetchJSON } from '@/lib/transport';
import s from './execution-details.module.css';
import { ExecutionObservations } from './execution-observations';
import { failureSummary } from './failure-presentation';
import { SnapshotRefresh } from './snapshot-refresh';
import {
  executionRecordUrl,
  executionTaskScope,
  executionEventNeedsAttention,
  isRoutineExecutionEvent,
} from './execution-view';

// Project only the records needed for this read-only view. Agent launch arguments,
// authentication data and artifact contents are deliberately not retained here.
const RecordView = z.object({
  generatedAt: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      parentTaskId: z.string().optional(),
      title: z.string(),
      state: z.string(),
    }),
  ),
  agents: z.array(z.object({ definition: z.object({ id: z.string(), name: z.string() }) })),
  assignments: z.array(z.object({ id: z.string(), taskId: z.string(), agentId: z.string() })),
  executionAttempts: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        assignmentId: z.string(),
        number: z.number(),
        state: z.string(),
        createdAt: z.string(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
        failure: z
          .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
          .optional(),
      }),
    )
    .default([]),
  timeline: z.array(
    z.object({
      id: z.string(),
      taskId: z.string().optional(),
      type: z.string(),
      occurredAt: z.string(),
      actor: z.object({ id: z.string(), type: z.string().optional() }),
      payload: z.record(z.unknown()).optional(),
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      taskId: z.string().optional(),
      fromAgentId: z.string(),
      toAgentId: z.string().optional(),
      type: z.string(),
      createdAt: z.string(),
      content: z.string().optional(),
      artifactRefs: z.array(z.string()).default([]),
      replyTo: z.string().optional(),
      metadata: z.record(z.unknown()).default({}),
    }),
  ),
  messageDeliveries: z
    .array(
      z.object({
        messageId: z.string(),
        state: z.string(),
        reason: z.string(),
        recipientTaskId: z.string().optional(),
        deliveredAt: z.string().optional(),
      }),
    )
    .default([]),
  workspaces: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      rootPath: z.string(),
      provider: z.string(),
      access: z.string(),
      branchName: z.string().optional(),
    }),
  ),
  workspaceConfigs: z
    .array(
      z.object({
        id: z.string(),
        sourceWorkspaceId: z.string(),
        mode: z.string(),
      }),
    )
    .default([]),
  assignmentWorkspaces: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        workspaceId: z.string(),
        mode: z.string(),
      }),
    )
    .default([]),
});
type Records = z.infer<typeof RecordView>;
type Event = Records['timeline'][number];
type Attempt = Records['executionAttempts'][number];

const states: Record<string, string> = {
  draft: '草稿',
  planning: '安排工作中',
  ready: '准备执行',
  queued: '排队中',
  running: '正在执行',
  waiting: '等待中',
  waiting_approval: '等待你确认',
  blocked: '需要处理',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
  interrupted: '执行已中断',
};
const stages: Record<string, string> = {
  starting: '准备执行',
  workspace_prepare: '准备工作目录',
  context_build: '准备任务上下文',
  process_spawn: '启动成员程序',
  acp_initialize: '连接成员',
  session_create: '创建会话',
  session_resume: '恢复会话',
  acp_session: '建立成员会话',
  prompt: '成员处理要求',
  acp_prompt: '成员处理要求',
  agent_prompt: '成员处理要求',
  session_attachment: '建立会话与协作连接',
  artifact_publish: '保存结果产物',
  workspace_collect: '收集文件改动',
};
const events: Record<string, string> = {
  'execution.session.attached': '成员会话已建立',
  'agent.usage': '成员上报用量与缓存',
  'workspace.preview.saved': '页面预览快照已保存',
  'agent.progress': '成员回复记录',
  'agent.tool': '成员工具进展',
  'boss.selected': '已选择负责人',
  'agents.discovered': '已查找可协作成员',
  'task.created': '任务已创建',
  'task.delegated': '任务已委派',
  'task.followup.created': '已开始新一轮追问',
  'task.retry_requested': '已请求恢复任务',
  'task.cancelled': '任务已停止',
  'task.dependencies_changed': '已更新任务依赖',
  'assignment.created': '已分配执行成员',
  'attempt.created': '执行已排队',
  'attempt.started': '成员开始执行',
  'attempt.finished': '本次执行已结束',
  'attempt.interrupted': '执行中断，记录已保存',
  'execution.started': '成员开始执行',
  'execution.completed': '执行已完成',
  'execution.outcome.corrected': '已纠正历史误报：本轮执行失败',
  'execution.failed': '执行遇到问题',
  'execution.context.prepared': '已带入前文和相关产物',
  'workspace.assigned': '已分配工作目录',
  'workspace.continued': '已继承此前文件改动',
  'workspace.review.prepared': '已准备文件审阅快照',
  'conversation.attached': '已关联执行会话',
  'execution.boundary': '已记录本次执行权限边界',
  'client.tool.called': '客户端协作操作已记录',
  'worker.completed': '协作者已返回结果',
  'boss.completed': '负责人已完成汇总',
  'approval.requested': '操作等待你确认',
  'approval.decided': '已记录操作决定',
  'message.queued': '交接消息已排队',
  'message.claimed': '正在投递交接消息',
  'message.delivered': '交接消息已送达',
};
const toolLabels: Record<string, string> = {
  control_discover_agents: '查找协作成员',
  control_create_task: '创建子任务',
  control_delegate_task: '委派子任务',
  control_send_message: '发送协作消息',
  control_get_artifact: '读取任务产物',
  control_publish_artifact: '保存任务产物',
  control_get_task: '查看任务状态',
  control_wait_for_task: '等待任务结果',
};
const deliveryReasons: Record<string, string> = {
  queued: '等待投递',
  retry_delay: '等待下次投递',
  processing: '正在投递',
  lease_expired: '等待恢复投递',
  recipient_stopped: '接收方已停止，等待处理',
  recipient_approval: '接收方等待操作确认',
  recipient_terminal: '接收方已结束，尚未接收',
  recipient_unresolved: '尚未找到接收任务',
  acknowledged: '已送达',
  cancelled: '投递已取消',
  unavailable: '投递状态未提供',
};
const label = (map: Record<string, string>, value: string) => map[value] ?? value;
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const textField = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const clipped = (value: string, limit = 600) =>
  value.length > limit ? `${value.slice(0, limit)}…（内容已截短）` : value;

function eventTitle(event: Event) {
  if (event.type === 'agent.tool' && event.payload?.status === 'failed')
    return `Agent 报告工具失败（未附具体原因）${typeof event.payload.title === 'string' ? `：${clipped(event.payload.title, 160)}` : ''}`;
  if (event.type === 'agent.progress' && event.payload?.state === 'interrupted')
    return '成员回复中断，已保留收到的内容';
  if (event.type === 'approval.decided' && event.payload?.automatic === true)
    return event.payload.state === 'approved'
      ? '按项目权限自动批准文件操作'
      : '按项目权限自动拒绝操作';
  if (event.type === 'task.state_changed') {
    const to = textField(event.payload?.to);
    return to ? `任务${label(states, to)}` : '任务状态已更新';
  }
  if (event.type === 'fleet.tool') {
    const tool = textField(event.payload?.toolName);
    const outcome = textField(event.payload?.outcome);
    return `${tool ? label(toolLabels, tool) : '协作工具调用'}${outcome === 'denied' ? ' · 已拒绝' : outcome === 'failed' ? ' · 未成功' : ''}`;
  }
  return events[event.type] ?? '已记录执行事件';
}

function TechnicalDetails({ value }: { value: unknown }) {
  return (
    <details className={s.technical}>
      <summary>技术详情</summary>
      <pre>{clipped(JSON.stringify(value, null, 2) ?? '无详细信息', 8000)}</pre>
    </details>
  );
}

export function ExecutionDetails({ taskIds, onClose }: { taskIds: string[]; onClose: () => void }) {
  const [records, setRecords] = useState<Records>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selectedRound, setSelectedRound] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const recordUrl = executionRecordUrl(taskIds);
  const viewingRound = taskIds.includes(selectedRound) ? selectedRound : '';
  const scopeKey = JSON.stringify([...new Set(taskIds)].sort());
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRecords(undefined);
    setError('');
    const reader = new SnapshotRefresh(
      (signal) => fetchJSON(recordUrl, { signal }, RecordView),
      (next) => {
        setRecords(next);
        setError('');
      },
      (cause) => {
        setError(
          cause instanceof z.ZodError
            ? '执行记录格式暂时无法读取。'
            : '暂时无法刷新执行记录，请检查服务连接。',
        );
      },
    );
    async function refresh() {
      await reader.refresh();
      if (!disposed) timer = setTimeout(() => void refresh(), 2500);
    }
    void refresh();
    return () => {
      disposed = true;
      reader.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [scopeKey, retry, recordUrl]);

  // Include newly delegated descendants while the drawer stays open.
  const ids = executionTaskScope(taskIds, records?.tasks ?? [], viewingRound);
  const tasks = records?.tasks.filter((task) => ids.has(task.id)) ?? [];
  const projectIds = new Set(tasks.map((task) => task.projectId));
  const attempts = records?.executionAttempts.filter((attempt) => ids.has(attempt.taskId)) ?? [];
  const taskTitle = (id: string) => tasks.find((task) => task.id === id)?.title ?? id;
  const agentName = (id?: string) =>
    id === undefined
      ? '未指定接收成员'
      : (records?.agents.find((agent) => agent.definition.id === id)?.definition.name ??
        (id === 'system' ? '协作引擎' : id));
  const actorName = (event: Event) =>
    event.actor.type === 'user'
      ? '你'
      : event.actor.type === 'agent'
        ? agentName(event.actor.id)
        : '协作引擎';
  const timeline = (
    records?.timeline.filter((event) => event.taskId && ids.has(event.taskId)) ?? []
  ).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const milestones = timeline.filter((event) => !isRoutineExecutionEvent(event));
  const routineEvents = timeline.filter(isRoutineExecutionEvent);
  const messages = (
    records?.messages.filter((message) =>
      [
        message.taskId,
        message.metadata.senderTaskId,
        message.metadata.recipientTaskId,
        message.metadata.parentTaskId,
      ].some((id) => typeof id === 'string' && ids.has(id)),
    ) ?? []
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const bindings = records?.assignmentWorkspaces.filter((binding) => ids.has(binding.taskId)) ?? [];
  const workspaceIds = new Set(bindings.map((binding) => binding.workspaceId));
  const workspaceList =
    records?.workspaces.filter((workspace) => workspaceIds.has(workspace.id)) ?? [];
  const sourceIds = new Set(
    records?.workspaceConfigs
      .filter((config) => projectIds.has(config.id))
      .map((config) => config.sourceWorkspaceId),
  );
  const pendingWorkspaces = bindings.length
    ? []
    : (records?.workspaces.filter((workspace) => sourceIds.has(workspace.id)) ?? []);

  const execution = (attempt: Attempt) => {
    const assignment = records?.assignments.find((item) => item.id === attempt.assignmentId);
    const failureEvent = timeline.find(
      (event) =>
        event.taskId === attempt.taskId &&
        event.type === 'execution.failed' &&
        event.occurredAt >= attempt.createdAt &&
        (!attempt.finishedAt || event.occurredAt <= attempt.finishedAt),
    );
    const stage = textField(failureEvent?.payload?.stage);
    const failureText = failureSummary(attempt.failure?.message, attempt.failure?.code, false);
    return (
      <article
        className={s.card}
        key={attempt.id}
        data-attention={['failed', 'interrupted'].includes(attempt.state)}
      >
        <strong>{taskTitle(attempt.taskId)}</strong>
        <p>
          {agentName(assignment?.agentId)} · 第 {attempt.number} 次执行 ·{' '}
          {label(states, attempt.state)}
        </p>
        <small>
          {date(attempt.startedAt ?? attempt.createdAt)}
          {attempt.finishedAt ? ` → ${date(attempt.finishedAt)}` : ''}
        </small>
        {attempt.failure && (
          <div className={s.failure}>
            <p>{failureText}</p>
            {stage && <p>发生在：{label(stages, stage)}</p>}
            <p>
              {attempt.failure.retryable
                ? '支持恢复；修复问题后可回到会话继续任务。'
                : '此次执行不可直接重试，可保留记录并在会话中提出新要求。'}
            </p>
          </div>
        )}
        <TechnicalDetails value={attempt} />
      </article>
    );
  };
  const eventList = (items: Event[]) => (
    <ol className={s.timeline}>
      {items.map((event) => (
        <li key={event.id} data-attention={executionEventNeedsAttention(event)}>
          <strong>{eventTitle(event)}</strong>
          <small>
            {actorName(event)} · {date(event.occurredAt)}
          </small>
          {event.taskId && <p>{taskTitle(event.taskId)}</p>}
          <TechnicalDetails value={event} />
        </li>
      ))}
    </ol>
  );

  return (
    <aside className={s.panel} aria-label="执行过程">
      <header className={s.header}>
        <div>
          <h2>执行过程</h2>
          <p>会话中的执行、交接与工作目录</p>
        </div>
        <button type="button" aria-label="关闭执行过程" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className={s.navigation}>
        <label>
          查看范围
          <select
            aria-label="执行记录轮次"
            value={viewingRound}
            onChange={(event) => setSelectedRound(event.target.value)}
          >
            <option value="">全部轮次</option>
            {taskIds.map((id, index) => (
              <option key={id} value={id}>
                第 {index + 1} 轮
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="执行记录分类">
          {['执行状态', '上下文、记忆与缓存', '成员交接', '工作目录', '过程时间线'].map((name) => (
            <button
              key={name}
              type="button"
              disabled={!records}
              onClick={() => {
                const section = body.current?.querySelector<HTMLElement>(
                  `section[aria-label="${name}"]`,
                );
                if (!section) return;
                section.tabIndex = -1;
                section.scrollIntoView({ block: 'start' });
                section.focus({ preventScroll: true });
              }}
            >
              {name === '上下文、记忆与缓存' ? '上下文与记忆' : name}
            </button>
          ))}
        </nav>
      </div>
      <div className={s.body} ref={body}>
        {error && (
          <div className={s.error} role="alert">
            <p>{error}</p>
            {records && <p>以下为上次成功读取的记录。</p>}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              <RefreshCw size={14} /> 重新读取
            </button>
          </div>
        )}
        {!records && !error && (
          <p role="status" className={s.note}>
            正在读取已保存的执行记录…
          </p>
        )}
        {records && (
          <>
            <p className={s.note}>
              更新于 {date(records.generatedAt)}。查看记录不会启动成员或重试任务。
            </p>
            <section aria-label="执行状态">
              <h3>执行状态</h3>
              {tasks.length ? (
                tasks.map((task) => {
                  const history = attempts
                    .filter((attempt) => attempt.taskId === task.id)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
                  return (
                    <div key={task.id}>
                      {history[0] ? (
                        execution(history[0])
                      ) : (
                        <article className={s.card}>
                          <strong>{task.title}</strong>
                          <p>{label(states, task.state)} · 尚无执行记录</p>
                        </article>
                      )}
                      {history.length > 1 && (
                        <details className={s.group}>
                          <summary>此前执行（{history.length - 1}）</summary>
                          {history.slice(1).map(execution)}
                        </details>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className={s.note}>当前会话没有可显示的任务记录。</p>
              )}
            </section>
            <ExecutionObservations events={timeline} taskTitle={taskTitle} agentName={agentName} />
            <section aria-label="成员交接">
              <h3>
                成员交接 <span>{messages.length}</span>
              </h3>
              {messages.length ? (
                <>
                  <p className={s.note}>
                    “已送达”表示接收方完成了接收轮次；是否完成要求，请结合任务和结果查看。
                  </p>
                  {messages.map((message) => {
                    const delivery = records.messageDeliveries.find(
                      (item) => item.messageId === message.id,
                    );
                    const recipientTaskId =
                      delivery?.recipientTaskId ?? textField(message.metadata.recipientTaskId);
                    return (
                      <article key={message.id} className={s.card}>
                        <strong>
                          {agentName(message.fromAgentId)} → {agentName(message.toAgentId)}
                        </strong>
                        <p>
                          {label(
                            {
                              request: '协作请求',
                              response: '协作回复',
                              handoff: '工作交接',
                              event: '结果通知',
                              status: '状态通知',
                              message: '协作消息',
                            },
                            message.type,
                          )}{' '}
                          · {delivery ? label(deliveryReasons, delivery.reason) : '投递状态未提供'}
                        </p>
                        <small>{date(message.createdAt)}</small>
                        {recipientTaskId && (
                          <p className={s.note}>接收任务：{taskTitle(recipientTaskId)}</p>
                        )}
                        {message.content && (
                          <details className={s.group}>
                            <summary>查看消息</summary>
                            <p className={s.content}>{clipped(message.content, 1800)}</p>
                          </details>
                        )}
                        {message.artifactRefs.length > 0 && (
                          <p className={s.note}>
                            附带 {message.artifactRefs.length} 个产物引用，可在“结果”中查看。
                          </p>
                        )}
                        <TechnicalDetails
                          value={{
                            messageId: message.id,
                            replyTo: message.replyTo,
                            metadata: message.metadata,
                            delivery,
                          }}
                        />
                      </article>
                    );
                  })}
                </>
              ) : (
                <p className={s.note}>尚未记录成员之间的交接消息。</p>
              )}
            </section>
            <section aria-label="工作目录">
              <h3>工作目录</h3>
              {[...workspaceList, ...pendingWorkspaces].map((workspace) => {
                const usedBy = bindings.filter((binding) => binding.workspaceId === workspace.id);
                return (
                  <article key={workspace.id} className={s.card}>
                    <strong>
                      {usedBy.length ? '执行使用的目录' : '项目源目录 · 尚未分配执行目录'}
                    </strong>
                    <p className={s.path}>{workspace.rootPath}</p>
                    <p>
                      {label(
                        { 'local-directory': '本机文件夹', 'git-worktree': 'Git 工作树' },
                        workspace.provider,
                      )}{' '}
                      · {workspace.access === 'read-only' ? '配置为只读' : '配置为可写'}
                    </p>
                    {workspace.branchName && <p>分支：{workspace.branchName}</p>}
                    {usedBy.map((binding) => (
                      <small key={binding.id}>
                        {taskTitle(binding.taskId)} ·{' '}
                        {label(
                          {
                            'task-local': '独立任务目录',
                            'git-worktree': '独立工作树',
                            'shared-directory': '共享项目目录',
                          },
                          binding.mode,
                        )}
                      </small>
                    ))}
                  </article>
                );
              })}
              {!workspaceList.length && !pendingWorkspaces.length && (
                <p className={s.note}>尚未记录工作目录。</p>
              )}
              <p className={s.boundary}>
                本机进程和 Git 工作树不是系统安全沙箱。协作引擎检查经它转发的操作；Agent
                自有工具的文件、命令和网络访问仍取决于 Agent 及操作系统的权限。
              </p>
            </section>
            <section aria-label="过程时间线">
              <h3>过程时间线</h3>
              <p className={s.note}>
                最近事件在前。优先显示关键进展和异常；逐条工具、回复与用量记录可在下方展开。
              </p>
              {milestones.length ? (
                eventList(milestones.slice(0, 20))
              ) : (
                <p className={s.note}>尚无关键过程记录。</p>
              )}
              {milestones.length > 20 && (
                <details className={s.group}>
                  <summary>更早的过程（{milestones.length - 20}）</summary>
                  {eventList(milestones.slice(20))}
                </details>
              )}
              {routineEvents.length > 0 && (
                <details className={s.group}>
                  <summary>工具、回复与详细记录（{routineEvents.length}）</summary>
                  {eventList(routineEvents)}
                </details>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
