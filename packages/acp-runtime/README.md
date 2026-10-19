# acp-runtime

ACP client lifecycle and normalized agent events.

Responsibilities:
- probe/initialize
- auth readiness
- session new/resume
- prompt streaming
- cancellation
- permission forwarding

Must not own durable Task state.
