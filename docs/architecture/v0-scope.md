# V0 Scope and Acceptance Criteria

## Product statement
A local user can register arbitrary stdio ACP agents, authorize them independently, choose any eligible agent as Boss, and let the Boss discover/delegate work to other ACP workers through a durable, observable control plane.

## Must-have
- AgentDefinition CRUD
- stdio ACP LocalRunner
- best-effort runtime/auth readiness with explicit unknown/not-reported states
- capability registry/search
- selectable Boss with explicit bridge scopes
- Fleet MCP bridge attached to supported ACP sessions on creation and resume
- Task CRUD/state machine
- task delegation and execution attempts
- durable Message Router with outbox/inbox, idempotency, and restart recovery
- direct A->B logical messaging through the router; initiating agents require the messaging scope
- conversation/session references separated from task state
- local artifact store
- SQLite persistence/restart recovery
- baseline policy/approval for control-plane-mediated operations
- explicit enforcement-mode reporting and LocalRunner security warning
- local directory + Git worktree workspace
- event/timeline API
- minimal web UI for agents/tasks/timeline/approvals
- E2E demonstration with at least two different ACP agents

## Demo acceptance scenario
1. Register Agent A and Agent B through configuration/UI.
2. Complete each agent's supported native authorization flow; show unknown/not-reported when status cannot be determined.
3. Mark Agent A as Boss-capable, grant the required bridge scope, and select it for a project.
4. Create an ACP session for Agent A and attach the scoped Fleet MCP bridge using session configuration when supported.
5. User gives Boss a goal.
6. Boss calls `control_discover_agents`, creates a subtask, and delegates it to Agent B.
7. Agent B runs in an independent ACP session and returns a durable result/artifact.
8. Boss receives completion/result references and continues.
9. Restart the control-plane server; task/message/event history remains visible and pending deliveries recover.
10. Verify bridge calls are scoped and audited. Verify the UI does not claim opaque LocalRunner tool side effects are strictly intercepted.

## Messaging acceptance scenario
- Worker A with `agent.messaging` can send a request to Worker B through the durable router.
- Worker B can receive and answer without being granted Boss orchestration tools.
- A worker with no bridge can still execute assigned work but cannot initiate routed messages.
- Duplicate delivery does not create duplicate logical messages; delivery resumes after restart.

## Explicitly deferred
- mandatory A2A transport
- vector database
- automatic role taxonomy
- model scoring/routing ML
- Kubernetes
- hosted multi-tenant cloud
- billing
- enterprise RBAC/SSO
- arbitrary distributed transaction semantics
- full OpenHands integration
- Antigravity-specific adapter
- strong process isolation for every LocalRunner task; strict security boundaries require a suitable OS/container runner

## Architecture exit criteria
V0 implementation may start when:
- domain model is accepted
- ACP/runtime and Runner boundaries are accepted
- Boss/worker bridge scopes and session attachment are accepted
- durable Task/Conversation separation is accepted
- policy enforcement limits and approval boundary are accepted
