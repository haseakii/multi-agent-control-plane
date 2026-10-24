import { expect, it } from 'vitest';
import { MessageDeliveryViewSchema } from '../../../packages/core/src/message-delivery-view';
import { deliveryForMessage, deliveryPresentation, matchesMessageFilter } from './message-delivery';
import type { Snapshot } from './view-model';

it('separates pending, attention and completed turns without treating missing receipts as read', () => {
  const make = (
    state: 'pending' | 'delivering' | 'delivered',
    reason: 'queued' | 'lease_expired' | 'recipient_approval' | 'acknowledged',
  ) => MessageDeliveryViewSchema.parse({ messageId: 'm', projectId: 'p', state, reason });
  expect(matchesMessageFilter(make('pending', 'queued'), 'pending')).toBe(true);
  expect(matchesMessageFilter(make('pending', 'queued'), 'attention')).toBe(false);
  expect(matchesMessageFilter(make('delivering', 'lease_expired'), 'attention')).toBe(true);
  expect(matchesMessageFilter(make('pending', 'recipient_approval'), 'attention')).toBe(true);
  expect(matchesMessageFilter(make('delivered', 'acknowledged'), 'pending')).toBe(false);
  expect(deliveryPresentation(make('delivered', 'acknowledged')).label).toBe(
    '包含消息的轮次已结束',
  );
  expect(deliveryPresentation(undefined).label).toBe('投递记录不可用');
  const foreign = { ...make('delivered', 'acknowledged'), projectId: 'other' };
  expect(
    deliveryForMessage(
      {
        id: 'm',
        projectId: 'p',
        fromAgentId: 'a',
        toAgentId: 'b',
        type: 'message',
        createdAt: '2026-10-22T00:00:00Z',
      },
      { messageDeliveries: [foreign] } as Snapshot,
    ),
  ).toBeUndefined();
});
