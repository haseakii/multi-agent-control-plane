import {
  AgentIdSchema,
  AgentMessageSchema,
  MessageIdSchema,
  ProjectIdSchema,
} from '@control-plane/core';
import type { AgentMessage } from '@control-plane/core';
import { mailboxKeyFor } from './sqlite-store.js';
import {
  MessageRouterError,
  SendMessageInputSchema,
  type AuthenticatedSender,
  type ClaimedMessage,
  type MessageRouterOptions,
  type MessageRouterStore,
  type RoutedMessage,
  type SendMessageInput,
} from './types.js';

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

export class MessageRouter {
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly store: MessageRouterStore,
    private readonly options: MessageRouterOptions,
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async send(senderInput: AuthenticatedSender, input: SendMessageInput): Promise<RoutedMessage> {
    const sender: AuthenticatedSender = {
      projectId: ProjectIdSchema.parse(senderInput.projectId),
      agentId: AgentIdSchema.parse(senderInput.agentId),
    };
    const parsed = SendMessageInputSchema.parse(input);

    const decision = await this.options.hooks.authorize({ sender, input: parsed });
    if (!decision.allowed) {
      await this.options.hooks.audit({
        type: 'message.denied',
        sender,
        input: parsed,
        reason: decision.reason,
      });
      throw new MessageRouterError('POLICY_DENIED', decision.reason);
    }

    const result = this.store.transaction(() => {
      if (parsed.idempotencyKey) {
        const existing = this.store.findMessageByIdempotency(
          sender.projectId,
          sender.agentId,
          parsed.idempotencyKey,
        );
        if (existing) {
          const delivery = this.store.getDeliveryByMessage(existing.id);
          if (!delivery) {
            throw new MessageRouterError(
              'DELIVERY_NOT_FOUND',
              `Delivery for idempotent message not found: ${existing.id}`,
            );
          }
          return { routed: { message: existing, delivery }, created: false };
        }
      }

      this.options.hooks.beforeEnqueue?.({ sender, input: parsed });

      const messageId = MessageIdSchema.parse(this.options.idFactory('message'));
      const recipientAgentId = AgentIdSchema.parse(parsed.toAgentId);
      let correlationId = parsed.correlationId ?? messageId;

      if (parsed.replyTo) {
        const parent = this.store.getMessage(parsed.replyTo);
        if (!parent || parent.projectId !== sender.projectId) {
          throw new MessageRouterError(
            'INVALID_REPLY_CHAIN',
            `Reply target is unavailable in this project: ${parsed.replyTo}`,
          );
        }
        correlationId = parsed.correlationId ?? parent.correlationId ?? parent.id;
      }

      const now = this.options.now();
      const message = AgentMessageSchema.parse({
        id: messageId,
        projectId: sender.projectId,
        taskId: parsed.taskId,
        fromAgentId: sender.agentId,
        toAgentId: recipientAgentId,
        type: parsed.type,
        correlationId,
        replyTo: parsed.replyTo,
        idempotencyKey: parsed.idempotencyKey,
        content: parsed.content,
        artifactRefs: parsed.artifactRefs,
        metadata: parsed.metadata,
        createdAt: now,
      });

      const saved = this.store.saveMessage(message);
      const delivery = this.store.enqueueDelivery({
        id: this.options.idFactory('delivery'),
        messageId: saved.id,
        projectId: saved.projectId,
        recipientAgentId,
        mailboxKey:
          parsed.mailboxKey ??
          mailboxKeyFor({
            projectId: saved.projectId,
            recipientAgentId,
            taskId: saved.taskId,
          }),
        availableAt: now,
      });
      return { routed: { message: saved, delivery }, created: true };
    });

    if (result.created) {
      await this.options.hooks.audit({
        type: 'message.queued',
        sender,
        message: result.routed.message,
        delivery: result.routed.delivery,
      });
    }
    return result.routed;
  }

  async claimNext(
    recipientAgentIdInput: string,
    options?: { mailboxKey?: string; now?: string },
  ): Promise<ClaimedMessage | undefined> {
    const recipientAgentId = AgentIdSchema.parse(recipientAgentIdInput);
    const now = options?.now ?? this.options.now();
    const delivery = this.store.claimNext({
      recipientAgentId,
      now,
      leaseUntil: addMilliseconds(now, this.leaseMs),
      mailboxKey: options?.mailboxKey,
    });
    if (!delivery) {
      return undefined;
    }

    const message = this.store.getMessage(delivery.messageId);
    if (!message) {
      throw new MessageRouterError(
        'MESSAGE_NOT_FOUND',
        `Message for delivery not found: ${delivery.messageId}`,
      );
    }

    await this.options.hooks.audit({
      type: 'message.claimed',
      messageId: message.id,
      delivery,
    });
    return { message, delivery };
  }

  get claimRenewalIntervalMs(): number {
    return Math.max(1, Math.floor(this.leaseMs / 3));
  }

  renewClaim(deliveryId: string, expectedAttemptCount: number): void {
    const now = this.options.now();
    this.store.renewClaim(
      deliveryId,
      expectedAttemptCount,
      now,
      addMilliseconds(now, this.leaseMs),
    );
  }

  async acknowledge(
    deliveryId: string,
    expectedAttemptCount: number,
    deliveredAt = this.options.now(),
  ): Promise<void> {
    const delivery = this.store.markDelivered(deliveryId, expectedAttemptCount, deliveredAt);
    await this.options.hooks.audit({
      type: 'message.delivered',
      messageId: MessageIdSchema.parse(delivery.messageId),
      delivery,
    });
  }

  async retry(
    deliveryId: string,
    expectedAttemptCount: number,
    error: string,
    options?: { now?: string; delayMs?: number },
  ): Promise<void> {
    const now = options?.now ?? this.options.now();
    const delivery = this.store.scheduleRetry(
      deliveryId,
      expectedAttemptCount,
      addMilliseconds(now, options?.delayMs ?? this.retryDelayMs),
      error,
    );
    await this.options.hooks.audit({
      type: 'message.retry_scheduled',
      messageId: MessageIdSchema.parse(delivery.messageId),
      delivery,
    });
  }

  recoverExpired(now = this.options.now()): number {
    return this.store.recoverExpired(now);
  }

  getMessage(id: string): AgentMessage {
    const message = this.store.getMessage(id);
    if (!message) {
      throw new MessageRouterError('MESSAGE_NOT_FOUND', `Message not found: ${id}`);
    }
    return message;
  }
}
