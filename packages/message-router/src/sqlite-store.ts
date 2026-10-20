import { AgentMessageSchema, AgentIdSchema, ProjectIdSchema } from '@control-plane/core';
import type { AgentId, AgentMessage, ProjectId } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import {
  MessageDeliverySchema,
  MessageRouterError,
  type MessageDelivery,
  type MessageRouterStore,
} from './types.js';

function parseDeliveryRow(row: { payload: string } | undefined): MessageDelivery | undefined {
  return row ? MessageDeliverySchema.parse(JSON.parse(row.payload)) : undefined;
}

export class SqliteMessageRouterStore implements MessageRouterStore {
  constructor(private readonly storage: SqliteStorage) {}

  transaction<T>(operation: () => T): T {
    return this.storage.repositories.transaction(operation);
  }

  findMessageByIdempotency(
    projectId: ProjectId,
    fromAgentId: AgentId,
    idempotencyKey: string,
  ): AgentMessage | undefined {
    const row = this.storage.sqlite
      .prepare(
        `SELECT payload
         FROM messages
         WHERE project_id = ?
           AND from_agent_id = ?
           AND json_extract(payload, '$.idempotencyKey') = ?
         ORDER BY rowid
         LIMIT 1`,
      )
      .get(projectId, fromAgentId, idempotencyKey) as { payload: string } | undefined;
    return row ? AgentMessageSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  getMessage(id: string): AgentMessage | undefined {
    return this.storage.repositories.messages.get(id);
  }

  saveMessage(message: AgentMessage): AgentMessage {
    return this.storage.repositories.messages.upsert(message);
  }

  enqueueDelivery(input: {
    id: string;
    messageId: string;
    projectId: string;
    recipientAgentId: string;
    mailboxKey: string;
    availableAt: string;
  }): MessageDelivery {
    const sequenceRow = this.storage.sqlite
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM message_deliveries WHERE mailbox_key = ?',
      )
      .get(input.mailboxKey) as { sequence: number };

    const delivery = MessageDeliverySchema.parse({
      ...input,
      sequence: sequenceRow.sequence,
      state: 'pending',
      attemptCount: 0,
    });

    this.storage.sqlite
      .prepare(
        `INSERT INTO message_deliveries (
           id, message_id, project_id, recipient_agent_id, mailbox_key, sequence,
           state, attempt_count, available_at, lease_until, payload
         ) VALUES (
           @id, @messageId, @projectId, @recipientAgentId, @mailboxKey, @sequence,
           @state, @attemptCount, @availableAt, NULL, @payload
         )`,
      )
      .run({
        ...delivery,
        payload: JSON.stringify(delivery),
      });
    return structuredClone(delivery);
  }

  getDelivery(id: string): MessageDelivery | undefined {
    const row = this.storage.sqlite
      .prepare('SELECT payload FROM message_deliveries WHERE id = ?')
      .get(id) as { payload: string } | undefined;
    return parseDeliveryRow(row);
  }

  getDeliveryByMessage(messageId: string): MessageDelivery | undefined {
    const row = this.storage.sqlite
      .prepare('SELECT payload FROM message_deliveries WHERE message_id = ? ORDER BY rowid LIMIT 1')
      .get(messageId) as { payload: string } | undefined;
    return parseDeliveryRow(row);
  }

  claimNext(input: {
    recipientAgentId: string;
    now: string;
    leaseUntil: string;
    mailboxKey?: string;
  }): MessageDelivery | undefined {
    this.recoverExpired(input.now);

    return this.transaction(() => {
      const params: Record<string, string> = {
        recipientAgentId: input.recipientAgentId,
        now: input.now,
      };
      const mailboxClause = input.mailboxKey ? 'AND d.mailbox_key = @mailboxKey' : '';
      if (input.mailboxKey) {
        params.mailboxKey = input.mailboxKey;
      }

      const row = this.storage.sqlite
        .prepare(
          `SELECT d.payload
           FROM message_deliveries d
           WHERE d.recipient_agent_id = @recipientAgentId
             AND d.state = 'pending'
             AND d.available_at <= @now
             ${mailboxClause}
             AND NOT EXISTS (
               SELECT 1
               FROM message_deliveries earlier
               WHERE earlier.mailbox_key = d.mailbox_key
                 AND earlier.sequence < d.sequence
                 AND earlier.state NOT IN ('delivered', 'cancelled')
             )
           ORDER BY d.available_at, d.mailbox_key, d.sequence
           LIMIT 1`,
        )
        .get(params) as { payload: string } | undefined;
      const current = parseDeliveryRow(row);
      if (!current) {
        return undefined;
      }

      const next = MessageDeliverySchema.parse({
        ...current,
        state: 'delivering',
        attemptCount: current.attemptCount + 1,
        leaseUntil: input.leaseUntil,
        lastError: undefined,
      });
      this.updateDelivery(next);
      return next;
    });
  }

  markDelivered(id: string, deliveredAt: string): MessageDelivery {
    return this.transaction(() => {
      const current = this.requireDelivery(id);
      const next = MessageDeliverySchema.parse({
        ...current,
        state: 'delivered',
        deliveredAt,
        leaseUntil: undefined,
        lastError: undefined,
      });
      this.updateDelivery(next);
      return next;
    });
  }

  scheduleRetry(id: string, availableAt: string, error: string): MessageDelivery {
    return this.transaction(() => {
      const current = this.requireDelivery(id);
      const next = MessageDeliverySchema.parse({
        ...current,
        state: 'pending',
        availableAt,
        leaseUntil: undefined,
        lastError: error,
      });
      this.updateDelivery(next);
      return next;
    });
  }

  recoverExpired(now: string): number {
    const rows = this.storage.sqlite
      .prepare(
        `SELECT payload
         FROM message_deliveries
         WHERE state = 'delivering'
           AND lease_until IS NOT NULL
           AND lease_until <= ?
         ORDER BY mailbox_key, sequence`,
      )
      .all(now) as Array<{ payload: string }>;

    let recovered = 0;
    this.transaction(() => {
      for (const row of rows) {
        const current = MessageDeliverySchema.parse(JSON.parse(row.payload));
        const next = MessageDeliverySchema.parse({
          ...current,
          state: 'pending',
          availableAt: now,
          leaseUntil: undefined,
          lastError: 'Delivery lease expired before acknowledgement.',
        });
        this.updateDelivery(next);
        recovered += 1;
      }
    });
    return recovered;
  }

  private requireDelivery(id: string): MessageDelivery {
    const delivery = this.getDelivery(id);
    if (!delivery) {
      throw new MessageRouterError('DELIVERY_NOT_FOUND', `Message delivery not found: ${id}`);
    }
    return delivery;
  }

  private updateDelivery(delivery: MessageDelivery): void {
    const parsed = MessageDeliverySchema.parse(delivery);
    this.storage.sqlite
      .prepare(
        `UPDATE message_deliveries
         SET state = @state,
             attempt_count = @attemptCount,
             available_at = @availableAt,
             lease_until = @leaseUntil,
             payload = @payload
         WHERE id = @id`,
      )
      .run({
        id: parsed.id,
        state: parsed.state,
        attemptCount: parsed.attemptCount,
        availableAt: parsed.availableAt,
        leaseUntil: parsed.leaseUntil ?? null,
        payload: JSON.stringify(parsed),
      });
  }
}

export function mailboxKeyFor(input: {
  projectId: string;
  recipientAgentId: string;
  taskId?: string | undefined;
}): string {
  const projectId = ProjectIdSchema.parse(input.projectId);
  const recipientAgentId = AgentIdSchema.parse(input.recipientAgentId);
  return input.taskId
    ? `project:${projectId}:task:${input.taskId}:agent:${recipientAgentId}`
    : `project:${projectId}:agent:${recipientAgentId}`;
}
