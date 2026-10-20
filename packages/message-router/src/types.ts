import type { AgentId, AgentMessage, MessageId, ProjectId } from '@control-plane/core';
import { z } from 'zod';

export const MessageDeliveryStateSchema = z.enum([
  'pending',
  'delivering',
  'delivered',
  'cancelled',
]);
export type MessageDeliveryState = z.infer<typeof MessageDeliveryStateSchema>;

export const MessageDeliverySchema = z
  .object({
    id: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    recipientAgentId: z.string().min(1).max(128),
    mailboxKey: z.string().min(1).max(512),
    sequence: z.number().int().positive(),
    state: MessageDeliveryStateSchema,
    attemptCount: z.number().int().nonnegative(),
    availableAt: z.iso.datetime({ offset: true }),
    leaseUntil: z.iso.datetime({ offset: true }).optional(),
    deliveredAt: z.iso.datetime({ offset: true }).optional(),
    lastError: z.string().min(1).optional(),
  })
  .strict();
export type MessageDelivery = z.infer<typeof MessageDeliverySchema>;

export const SendMessageInputSchema = z
  .object({
    toAgentId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128).optional(),
    mailboxKey: z.string().min(1).max(512).optional(),
    type: z.enum(['request', 'response', 'message', 'handoff', 'event', 'status']),
    correlationId: z.string().min(1).optional(),
    replyTo: z.string().min(1).max(128).optional(),
    idempotencyKey: z.string().min(1).max(256).optional(),
    content: z.string().optional(),
    artifactRefs: z.array(z.string().min(1).max(128)).default([]),
    metadata: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export type SendMessageInput = z.input<typeof SendMessageInputSchema>;

export type AuthenticatedSender = {
  projectId: ProjectId;
  agentId: AgentId;
};

export type RoutedMessage = {
  message: AgentMessage;
  delivery: MessageDelivery;
};

export type ClaimedMessage = RoutedMessage;

export type MessageAuthorizationRequest = {
  sender: AuthenticatedSender;
  input: SendMessageInput;
};

export type MessageAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type MessageRouterAuditEvent =
  | {
      type: 'message.queued';
      sender: AuthenticatedSender;
      message: AgentMessage;
      delivery: MessageDelivery;
    }
  | {
      type: 'message.claimed' | 'message.delivered' | 'message.retry_scheduled';
      messageId: MessageId;
      delivery: MessageDelivery;
    }
  | {
      type: 'message.denied';
      sender: AuthenticatedSender;
      input: SendMessageInput;
      reason: string;
    };

export type MessageRouterHooks = {
  authorize(request: MessageAuthorizationRequest): Promise<MessageAuthorizationDecision>;
  audit(event: MessageRouterAuditEvent): Promise<void>;
};

export type MessageRouterIdFactory = (kind: 'message' | 'delivery') => string;

export type MessageRouterOptions = {
  now: () => string;
  idFactory: MessageRouterIdFactory;
  hooks: MessageRouterHooks;
  leaseMs?: number | undefined;
  retryDelayMs?: number | undefined;
};

export interface MessageRouterStore {
  transaction<T>(operation: () => T): T;
  findMessageByIdempotency(
    projectId: ProjectId,
    fromAgentId: AgentId,
    idempotencyKey: string,
  ): AgentMessage | undefined;
  getMessage(id: string): AgentMessage | undefined;
  saveMessage(message: AgentMessage): AgentMessage;
  enqueueDelivery(input: {
    id: string;
    messageId: string;
    projectId: string;
    recipientAgentId: string;
    mailboxKey: string;
    availableAt: string;
  }): MessageDelivery;
  getDelivery(id: string): MessageDelivery | undefined;
  getDeliveryByMessage(messageId: string): MessageDelivery | undefined;
  claimNext(input: {
    recipientAgentId: string;
    now: string;
    leaseUntil: string;
    mailboxKey?: string | undefined;
  }): MessageDelivery | undefined;
  markDelivered(id: string, deliveredAt: string): MessageDelivery;
  scheduleRetry(id: string, availableAt: string, error: string): MessageDelivery;
  recoverExpired(now: string): number;
}

export class MessageRouterError extends Error {
  constructor(
    readonly code:
      | 'POLICY_DENIED'
      | 'MESSAGE_NOT_FOUND'
      | 'DELIVERY_NOT_FOUND'
      | 'INVALID_REPLY_CHAIN',
    message: string,
  ) {
    super(message);
    this.name = 'MessageRouterError';
  }
}
