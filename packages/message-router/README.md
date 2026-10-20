# message-router

Durable control-plane-mediated agent messaging for V0.

The router separates logical Agent A -> Agent B communication from ACP process handles and provider credentials. A caller supplies an authenticated sender identity separately from the message body, then the router persists the envelope and a recipient delivery record before delivery is attempted.

V0 semantics:
- request/response/message/handoff/event/status envelopes
- SQLite durable envelope + mailbox delivery state
- at-least-once delivery through acknowledgement leases
- idempotency keys scoped by project + authenticated sender
- FIFO ordering within a mailbox where practical
- restart recovery for expired in-flight deliveries
- correlation and reply chains
- explicit authorization and audit hooks
- no requirement for the Boss to proxy message bodies

Exactly-once delivery is intentionally not promised. If a process stops after the recipient handles a message but before acknowledgement, the lease expires and the same durable message may be delivered again. Consumers therefore receive stable message IDs and should be idempotent.
