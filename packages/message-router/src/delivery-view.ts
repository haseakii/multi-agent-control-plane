import {
  MessageDeliveryViewSchema,
  type AgentMessage,
  type MessageDeliveryView,
  type Task,
  type ExecutionAttempt,
} from '@control-plane/core';
import { MessageDeliverySchema, type MessageDelivery } from './types.js';

/** Read-only: never claim, recover, retry or start work while rendering a receipt. */
export function messageDeliveryView(
  message: AgentMessage,
  delivery: MessageDelivery | undefined,
  tasks: readonly Task[],
  observedAt: string,
  attempts: readonly ExecutionAttempt[] = [],
): MessageDeliveryView {
  const unavailable = {
    messageId: message.id,
    projectId: message.projectId,
    state: 'unavailable',
    reason: 'unavailable',
  } as const;
  if (
    !delivery ||
    delivery.messageId !== message.id ||
    delivery.projectId !== message.projectId ||
    delivery.recipientAgentId !== message.toAgentId
  )
    return MessageDeliveryViewSchema.parse(unavailable);
  const record = MessageDeliverySchema.parse(delivery);
  // Bind navigation to the durable mailbox, never Agent-supplied metadata.
  const recipient = tasks.find(
    (task) =>
      task.projectId === message.projectId &&
      record.mailboxKey === `task:${task.id}:agent:${record.recipientAgentId}`,
  );
  const latestAttempt =
    recipient && attempts.filter((attempt) => attempt.taskId === recipient.id).at(-1);
  let reason: MessageDeliveryView['reason'];
  if (record.state === 'delivered') reason = 'acknowledged';
  else if (record.state === 'cancelled') reason = 'cancelled';
  else if (record.state === 'delivering')
    reason =
      record.leaseUntil && Date.parse(record.leaseUntil) > Date.parse(observedAt)
        ? 'processing'
        : 'lease_expired';
  else if (!recipient) reason = 'recipient_unresolved';
  else if (['completed', 'cancelled'].includes(recipient.state)) reason = 'recipient_terminal';
  else if (recipient.state === 'waiting_approval') reason = 'recipient_approval';
  else if (
    ['failed', 'blocked'].includes(recipient.state) ||
    (latestAttempt && ['failed', 'interrupted'].includes(latestAttempt.state))
  )
    reason = 'recipient_stopped';
  else if (Date.parse(record.availableAt) > Date.parse(observedAt)) reason = 'retry_delay';
  else reason = 'queued';
  return MessageDeliveryViewSchema.parse({
    messageId: message.id,
    projectId: message.projectId,
    state: record.state,
    reason,
    recipientTaskId: recipient?.id,
    attemptCount: record.attemptCount,
    availableAt: record.availableAt,
    leaseUntil: record.leaseUntil,
    deliveredAt: record.deliveredAt,
    hasPreviousFailure: Boolean(record.lastError),
  });
}
