import { useState } from 'react';
import type { RoutedMessage, Snapshot } from './view-model';
import { messageResponse } from './view-model';
import { agentLabel } from './presentation';
import {
  deliveryForMessage,
  deliveryPresentation,
  matchesMessageFilter,
  type MessageFilter,
} from './message-delivery';

const types: Record<string, string> = {
  request: '请求',
  response: '回复',
  message: '消息',
  handoff: '交接',
  event: '事件',
  status: '状态',
};

export function MessagePanel({
  messages,
  snapshot,
  onOpenArtifact,
  onSelectTask,
}: {
  messages: RoutedMessage[];
  snapshot: Snapshot | null;
  onOpenArtifact: (id: string, trigger: HTMLElement) => void;
  onSelectTask?: (id: string) => void;
}) {
  const [filter, setFilter] = useState<MessageFilter>('all');
  const visible = messages.filter((message) =>
    matchesMessageFilter(deliveryForMessage(message, snapshot), filter),
  );
  const count = (choice: MessageFilter) =>
    messages.filter((message) =>
      matchesMessageFilter(deliveryForMessage(message, snapshot), choice),
    ).length;
  return (
    <section className="execution-record" aria-label="协作消息">
      <h2>协作消息</h2>
      <p className="section-note">请求、回复和结果由控制台保存；结果已保存不代表 Agent 已读取。</p>
      <div className="message-filter" role="group" aria-label="筛选协作消息">
        {(
          [
            ['all', '全部'],
            ['pending', '尚未完成投递'],
            ['attention', '需查看'],
          ] as const
        ).map(([choice, label]) => (
          <button
            key={choice}
            type="button"
            aria-pressed={filter === choice}
            onClick={() => setFilter(choice)}
          >
            {label}（{count(choice)}）
          </button>
        ))}
      </div>
      <div className="message-list">
        {visible.map((message) => {
          const receipt = deliveryForMessage(message, snapshot),
            delivery = deliveryPresentation(receipt);
          const recipientTask = snapshot?.tasks.find(
            (task) => task.id === receipt?.recipientTaskId && task.projectId === message.projectId,
          );
          const request = message.replyTo
            ? messages.find(
                (item) => item.id === message.replyTo && item.projectId === message.projectId,
              )
            : undefined;
          const response =
            message.type === 'request' ? messageResponse(message, messages) : undefined;
          const artifacts = [...new Set(message.artifactRefs ?? [])];
          return (
            <article className="message-card" key={message.id}>
              <div className="message-route">
                <strong>{agentLabel(message.fromAgentId, snapshot)}</strong>
                <span aria-hidden="true">→</span>
                <strong>
                  {message.toAgentId ? agentLabel(message.toAgentId, snapshot) : '控制台'}
                </strong>
                <span className="badge">{types[message.type] ?? message.type}</span>
                {message.type === 'request' ? (
                  <small>{response ? '回复已保存' : '等待回复'}</small>
                ) : null}
              </div>
              <div className={'message-delivery' + (delivery.attention ? ' attention' : '')}>
                <strong>{delivery.label}</strong>
                <p>{delivery.detail}</p>
                {recipientTask && onSelectTask ? (
                  <button type="button" onClick={() => onSelectTask(recipientTask.id)}>
                    查看接收任务：{recipientTask.title}
                  </button>
                ) : null}
              </div>
              <small>
                保存于{' '}
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleString()}
                </time>
              </small>
              {message.replyTo ? (
                <blockquote className="message-reply-context">
                  回复请求：{request?.content?.slice(0, 160) ?? '当前范围中没有原请求正文'}
                </blockquote>
              ) : null}
              {!message.taskId ? <small>项目级消息</small> : null}
              <p>
                {message.content ?? (artifacts.length ? '结果保存在下方产物中。' : '无内联正文')}
              </p>
              {message.metadata?.origin === 'control-plane-task-result' ? (
                <small>控制台保存的任务结果</small>
              ) : null}
              {artifacts.length ? (
                <div className="card-actions message-artifacts">
                  {artifacts.map((id, index) => {
                    const available = snapshot?.artifacts.some(
                      (artifact) => artifact.id === id && artifact.projectId === message.projectId,
                    );
                    return (
                      <button
                        type="button"
                        key={id}
                        disabled={!available}
                        data-result-trigger={'message:' + message.id + ':' + id}
                        onClick={(event) => onOpenArtifact(id, event.currentTarget)}
                      >
                        {available
                          ? '查看结果' + (artifacts.length > 1 ? ' ' + (index + 1) : '')
                          : '结果暂不可用'}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <details className="technical-details">
                <summary>消息技术详情</summary>
                <dl>
                  <dt>消息 ID</dt>
                  <dd>{message.id}</dd>
                  <dt>关联 ID</dt>
                  <dd>{message.correlationId ?? '未提供'}</dd>
                  {message.replyTo ? (
                    <>
                      <dt>回复消息 ID</dt>
                      <dd>{message.replyTo}</dd>
                    </>
                  ) : null}
                  <dt>任务 ID</dt>
                  <dd>{message.taskId ?? '项目级消息'}</dd>
                  <dt>领取次数</dt>
                  <dd>{receipt?.attemptCount ?? '无记录'}</dd>
                  {receipt?.deliveredAt ? (
                    <>
                      <dt>轮次确认时间</dt>
                      <dd>{new Date(receipt.deliveredAt).toLocaleString()}</dd>
                    </>
                  ) : null}
                  {receipt?.leaseUntil ? (
                    <>
                      <dt>当前领取有效期</dt>
                      <dd>{new Date(receipt.leaseUntil).toLocaleString()}</dd>
                    </>
                  ) : null}
                  {receipt?.state === 'pending' && receipt.availableAt ? (
                    <>
                      <dt>最早可领取时间</dt>
                      <dd>{new Date(receipt.availableAt).toLocaleString()}</dd>
                    </>
                  ) : null}
                  {receipt?.hasPreviousFailure ? (
                    <>
                      <dt>上次尝试</dt>
                      <dd>未完成，消息仍保留。</dd>
                    </>
                  ) : null}
                </dl>
              </details>
            </article>
          );
        })}
        {messages.length === 0 ? <p className="empty">当前任务范围还没有协作消息。</p> : null}
        {messages.length > 0 && visible.length === 0 ? (
          <p className="empty">没有符合当前筛选的消息。</p>
        ) : null}
      </div>
    </section>
  );
}
