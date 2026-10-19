# AGENTS.md

## Project intent
Build a local-first, vendor-neutral multi-agent control plane. Do not encode vendor names as domain roles.

## Architectural invariants
1. Agent and role are separate concepts.
2. Any eligible agent may become Boss; Boss is not a hard-coded model.
3. ACP is the primary host-to-agent transport for V0.
4. Agent-to-agent traffic must be mediated and auditable by the control plane.
5. Task state is durable and independent from ACP conversation/session state.
6. Authentication is agent-managed by default; never copy provider credentials into task payloads.
7. Large outputs travel as artifacts, not inline messages.
8. Policy/approval decisions are enforced outside the agent.
9. Local SQLite/filesystem implementations must sit behind interfaces so distributed implementations can be added later.
10. OpenHands integrations are optional adapters; the core must not depend on OpenHands.

## Development rules
- TypeScript strict mode.
- Public APIs require Zod schemas or equivalent runtime validation.
- Domain packages must not import from UI packages.
- Protocol/provider-specific code belongs behind adapters.
- New durable state changes require migration coverage.
- New orchestration behavior requires deterministic unit tests.
- Avoid introducing Kafka, Redis, vector databases, Kubernetes, or cloud-only services into V0.
- Do not silently auto-approve dangerous ACP permission requests.

## V0 priority
Prove one end-to-end path:
User -> Boss -> discover agents -> delegate task -> worker ACP session -> durable result -> Boss resumes -> final response.
