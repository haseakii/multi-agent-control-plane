# Agent-to-Agent Messaging

## Principle
Logical A -> B communication is always physically mediated by the control plane.

```text
Agent A
  |
  | Control Bridge
  v
Message Router -> durable outbox/inbox -> delivery
                                      |
                                      v
                                   Agent B
```

Agents do not receive credentials or direct process handles for other agents.

## Envelope

```ts
type AgentMessageType =
  | "request"
  | "response"
  | "message"
  | "handoff"
  | "event"
  | "status";

type AgentMessage = {
  id: string;
  projectId: string;
  taskId?: string;
  fromAgentId: string;
  toAgentId?: string;
  type: AgentMessageType;
  correlationId?: string;
  replyTo?: string;
  content?: string;
  artifactRefs: string[];
  createdAt: string;
};
```

## Delivery semantics
V0 uses:
- SQLite durable outbox/inbox
- at-least-once delivery
- idempotency keys on message delivery
- ordered mailbox per conversation/assignment where practical
- restart recovery

Exactly-once semantics are not promised.

## Direct agent communication
"Direct" means the Boss does not need to interpret every message. It does **not** mean bypassing the control plane.

Example:
```text
Worker A -> control.send_message(to=Worker B)
          -> Message Router
          -> Worker B
          -> response
          -> Worker A
```

The Boss receives task/status events but does not need to consume the message body unless policy or workflow requests it.

## Handoff
A handoff transfers responsibility, not identity. The original task remains durable. A handoff should normally create a new Assignment to the receiving agent and reference prior context/artifacts.

## Large payloads
Never inline large diffs, images, logs, directories, or test reports. Publish an Artifact and send references.

## Future transports
The Message Router API is transport-independent. A future A2A provider may deliver some messages natively while still emitting the same audit/message records.
