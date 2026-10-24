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

## C5 request result implementation

An accepted routed request is associated with its sender task and recipient task. When the recipient task reaches a terminal state, the control plane sends a response with replyTo/correlationId and result artifact references back to the original task mailbox, including when the recipient is an independently-running task. This is a response to accepted work, not an outbound tool grant. Initiating unrelated messages still requires agent.messaging.

Responses describe the completed task, not each individual streaming chunk. Failed/cancelled tasks return status without invented artifacts. Idempotency is based on the request message and terminal task generation. A resumed sender repairs a missing notification for completed requested tasks without rerunning the recipient. A reply retained after sender cancellation does not automatically start a new execution.

The task messages API and UI include messages related through authoritative routing task metadata. UI state distinguishes saved results from agent acknowledgement; delivery/claim events remain independently auditable.

## C6 explicit routing and retry receipts

control_send_message accepts optional targetTaskId, replyTo and idempotencyKey through one strict runtime schema shared by the HTTP executor and MCP server. Explicit targets must be active tasks of the recipient in the same project; an invalid explicit target never silently creates substitute work. Without an explicit target, one active recipient is reused, no active recipient creates a consumer, and multiple active recipients require disambiguation.

Replies must refer to a message delivered or currently claimed by this exact task, with matching project and agent pair. They return to the original sender task even when its Agent has multiple active tasks. Agent outbound messaging authority is still required.

An idempotency key is scoped to the sending task and stored as a bounded hash. Identical retries return the saved receipt, including after receiver completion or sender restart; changed intent conflicts. Within one V0 runtime, simultaneous identical calls share the same in-flight operation before creating a consumer. This is not a distributed exactly-once guarantee or a claim that an Agent has read the message.

## Operator delivery view

The control-center snapshot includes `messageDeliveries`, and
`GET /api/tasks/:id/message-deliveries` returns the same projection for the task's routed
messages. It reads the durable router store through its interface; it never claims, retries,
recovers leases or starts an Agent while rendering. No additional durable state or migration
is introduced. A missing or mismatched receipt is explicitly unavailable.

The view distinguishes pending delivery, a claimed but unfinished turn, an expired claim,
completed delivery and cancellation. Pending messages identify recipient approval waits,
failed/blocked/interrupted work and terminal recipient tasks. Recipient navigation is derived
from the persisted mailbox and same-project task identity, not from message metadata.
Raw retry error strings and internal mailbox keys are omitted from the operator projection.

The console offers all/pending/needs-attention filters, timestamps, claim count and a direct
recipient-task link. A response saved in the message store is shown separately from its
delivery acknowledgement. `delivered` means the ACP turn containing that message ended
successfully and the router recorded its acknowledgement; it does not establish semantic
understanding or fulfillment. Selecting a message/task does not resume it. Existing task and
approval controls retain their own explicit actions and fresh server-side eligibility checks.
