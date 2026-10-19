# acp-runtime

ACP client lifecycle, normalized agent events, and in-memory capability discovery.

Responsibilities:
- probe/initialize
- auth readiness
- session new/resume
- prompt streaming
- cancellation
- permission forwarding
- agent definition registry and capability registration
- exact, prefix, and caller-defined capability queries
- readiness and routing-policy filtering with deterministic selector metadata

Capability names and sources are routing metadata, not security grants. Selection filters are not a substitute for authorizing each control-plane operation at the execution boundary.

Must not own durable Task state. The in-memory registry is a V0 implementation detail; persistent registry implementations can be supplied behind the same application-facing contract later.
