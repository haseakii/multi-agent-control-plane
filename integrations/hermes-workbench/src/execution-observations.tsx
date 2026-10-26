import React from 'react';
import { z } from 'zod';
const Context = z.object({
  attemptId: z.string(),
  acceptedMemory: z
    .array(z.object({ id: z.string(), title: z.string(), content: z.string() }))
    .default([]),
  dependencies: z.array(z.unknown()).default([]),
  artifacts: z
    .array(z.object({ id: z.string(), contentOmitted: z.string().optional() }))
    .default([]),
  notes: z.array(z.string()).default([]),
});
type Event = {
  id: string;
  taskId?: string;
  type: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
};
const count = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v.toLocaleString('zh-CN') : '未上报';
export function ExecutionObservations({
  events,
  taskTitle,
  agentName,
}: {
  events: Event[];
  taskTitle: (id: string) => string;
  agentName: (id?: string) => string;
}) {
  const contexts = events
    .filter((e) => e.type === 'execution.context.prepared')
    .slice()
    .reverse();
  return (
    <section aria-label="上下文、记忆与缓存">
      <h3>上下文、记忆与缓存</h3>
      <p>前文和项目记忆由协作引擎带入；模型缓存仅显示 Agent 明确上报的数据，不将未知值记为零。</p>
      {contexts.map((event) => {
        const result = Context.safeParse(event.payload?.context);
        if (!result.success) return null;
        const context = result.data;
        const belongs = (e: Event) => e.payload?.attemptId === context.attemptId;
        const session = events.find((e) => e.type === 'execution.session.attached' && belongs(e));
        const usage = events.filter((e) => e.type === 'agent.usage' && belongs(e));
        const window = usage.find((e) => e.payload?.source === 'acp-session');
        const turns = new Map<string, Event>();
        for (const e of usage.slice().reverse())
          if (e.payload?.source === 'acp-prompt' && typeof e.payload.turnId === 'string')
            turns.set(e.payload.turnId, e);
        return (
          <article
            key={event.id}
            style={{
              border: '1px solid var(--h-line)',
              padding: 12,
              marginBottom: 12,
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            <strong>{event.taskId ? taskTitle(event.taskId) : '执行上下文'}</strong>
            <p>
              {context.dependencies.length} 个前文任务 · {context.artifacts.length} 个产物引用 ·{' '}
              {context.acceptedMemory.length} 条已确认记忆
            </p>
            <p>
              ACP 会话：
              {!session
                ? '此前版本未记录'
                : session.payload?.resumed
                  ? '恢复原会话'
                  : '新建会话，历史通过持久化上下文带入'}
            </p>
            {context.acceptedMemory.map((memory) => (
              <details key={memory.id}>
                <summary>项目记忆：{memory.title}</summary>
                <p>{memory.content}</p>
              </details>
            ))}
            {context.artifacts.some((a) => a.contentOmitted) && (
              <p>部分大产物仅带引用，由 Agent 按需读取完整内容。</p>
            )}
            {context.notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
            <p>
              上报上下文窗口：
              {window
                ? `${count(window.payload?.contextUsed)} / ${count(window.payload?.contextSize)} tokens`
                : '未上报'}
            </p>
            {turns.size ? (
              [...turns.values()].map((turn, i) => (
                <div key={turn.id}>
                  <strong>
                    {agentName(
                      typeof turn.payload?.agentId === 'string' ? turn.payload.agentId : undefined,
                    )}{' '}
                    · 第 {i + 1} 次提示的上报读数
                  </strong>
                  <p>
                    输入 {count(turn.payload?.inputTokens)} · 输出{' '}
                    {count(turn.payload?.outputTokens)} · 总量 {count(turn.payload?.totalTokens)}
                  </p>
                  <p>
                    缓存读取 {count(turn.payload?.cachedReadTokens)} · 缓存写入{' '}
                    {count(turn.payload?.cachedWriteTokens)} tokens
                  </p>
                </div>
              ))
            ) : (
              <p>模型用量与缓存：尚未上报。完成后若 Agent 提供这些字段，会保存在本次记录中。</p>
            )}
          </article>
        );
      })}
      {!contexts.length && <p>尚无已保存的上下文快照。</p>}
    </section>
  );
}
