import type { MessageDeliveryView } from '../../../packages/core/src/message-delivery-view';
import type { RoutedMessage, Snapshot } from './view-model';

export type MessageFilter = 'all' | 'pending' | 'attention';
const descriptions: Record<
  MessageDeliveryView['reason'],
  { label: string; detail: string; attention: boolean }
> = {
  unavailable: {
    label: '投递记录不可用',
    detail: '消息正文已保存，但没有可核对的投递记录。',
    attention: true,
  },
  queued: {
    label: '已保存 · 等待投递',
    detail: '消息仍在队列中，将在接收任务可处理的轮次送达。',
    attention: false,
  },
  retry_delay: {
    label: '等待再次投递',
    detail: '消息已保留，尚未到下次可领取时间。',
    attention: false,
  },
  processing: {
    label: '已领取 · 等待轮次结束',
    detail: '接收执行已领取消息，尚未记录轮次完成。',
    attention: false,
  },
  lease_expired: {
    label: '领取已过期 · 待核对',
    detail: '领取确认已过期，尚无本轮完成记录。请查看接收任务；打开此页不会重新执行。',
    attention: true,
  },
  recipient_stopped: {
    label: '接收任务待处理',
    detail: '消息仍在队列中。请查看接收任务的失败或阻塞原因，再决定是否恢复。',
    attention: true,
  },
  recipient_approval: {
    label: '接收任务等待审批',
    detail: '请查看接收任务的审批请求；消息不会替代你的审批决定。',
    attention: true,
  },
  recipient_terminal: {
    label: '接收任务已结束 · 消息保留',
    detail: '接收任务已完成或取消；该消息没有触发新的执行。',
    attention: true,
  },
  recipient_unresolved: {
    label: '接收任务未关联',
    detail: '投递记录仍保留，但当前没有可核对的接收任务。',
    attention: true,
  },
  acknowledged: {
    label: '包含消息的轮次已结束',
    detail: '控制平面已记录轮次完成；这不保证 Agent 理解或完成了消息中的要求。',
    attention: false,
  },
  cancelled: { label: '投递已取消', detail: '正文和投递历史仍保留。', attention: false },
};
export function deliveryForMessage(message: RoutedMessage, snapshot: Snapshot | null) {
  return snapshot?.messageDeliveries?.find(
    (row) => row.messageId === message.id && row.projectId === message.projectId,
  );
}
export function deliveryPresentation(receipt: MessageDeliveryView | undefined) {
  return descriptions[receipt?.reason ?? 'unavailable'];
}
export function matchesMessageFilter(
  receipt: MessageDeliveryView | undefined,
  filter: MessageFilter,
) {
  return (
    filter === 'all' ||
    (filter === 'pending'
      ? receipt?.state === 'pending' || receipt?.state === 'delivering'
      : deliveryPresentation(receipt).attention)
  );
}
