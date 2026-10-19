# Agent-to-Agent Messaging

## Principle
Logical A -> B communication is always mediated and audited by the control plane. "Direct" means the Boss does not need to interpret every message; it does not mean bypassing routing, policy, or persistence.

```text
Agent A -- scoped Control Bridge --> durable Message Router/outbox
                                      |
                                      v
                                target mailbox
                                      |
                                      v
                              Agent B ACP session
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
  idempotencyKey?: string;
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

## Worker-to-worker flow
1. The sender must have the `agent.messaging` bridge scope. A worker without a bridge may execute assigned work, but cannot initiate messages.
2. The router authenticates the sender, validates project/task scope, evaluates policy, and durably stores the message before attempting delivery.
3. The router queues delivery to the recipient's active assignment. If the recipient is busy or offline, delivery waits for a safe session boundary or a new/resumed ACP session; do not issue concurrent prompts unless the runtime explicitly supports safe multiplexing.
4. The recipient does not need an outbound bridge merely to receive a request or reply. The control plane can treat the response to the routed ACP work item as the correlated response message and persist it with provenance. To initiate a further message, the recipient needs its own `agent.messaging` scope.
5. The Boss receives task/status metadata and correlation events but need not inspect message bodies unless the workflow or policy requires it.

Example:
```text
Worker A -- control_send_message --> Message Router
                                      -> Worker B mailbox/session
Worker B ACP result ---------------> correlated response record
                                      -> Worker A receives result
```

The router is responsible for delivery attempts, retries, idempotency, ordering, cancellation, and restart recovery. It must not trust a caller-supplied `fromAgentId` without binding it to the authenticated bridge/session.

## Handoff
A handoff transfers responsibility, not identity. The original task remains durable. A handoff should normally create a new Assignment to the receiving agent and reference prior context/artifacts.

## Large payloads
Never inline large diffs, images, logs, directories, or test reports. Publish an Artifact and send references.

## Future transports
The Message Router API is transport-independent. A future A2A provider may deliver some messages natively while still emitting the same audit/message records.
