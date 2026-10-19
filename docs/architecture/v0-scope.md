# V0 Scope and Acceptance Criteria

## Product statement
A local user can register arbitrary stdio ACP agents, authorize them independently, choose any eligible agent as Boss, and let the Boss discover/delegate work to other agents through a durable, observable control plane.

## Must-have
- AgentDefinition CRUD
- stdio ACP LocalRunner
- independent agent auth/readiness status
- capability registry/search
- selectable Boss
- Fleet MCP bridge
- Task CRUD/state machine
- task delegation and execution attempts
- durable Message Router
- direct A->B logical messaging through router
- conversation/session references separated from task state
- local artifact store
- SQLite persistence/restart recovery
- baseline policy/approval
- local directory + Git worktree workspace
- event/timeline API
- minimal web UI for agents/tasks/timeline/approvals
- E2E demonstration with at least two different ACP agents

## Demo acceptance scenario
1. Register Agent A and Agent B through configuration/UI.
2. Complete their native authorization flows.
3. Mark Agent A as Boss-capable and select it for a project.
4. User gives Boss a goal.
5. Boss calls `control_discover_agents`.
6. Boss creates/delegates a subtask to Agent B.
7. Agent B runs in an independent ACP session.
8. Its result and artifacts are stored durably.
9. Boss receives completion/result references and continues.
10. Restart the control-plane server; task/message/event history remains visible.

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

## Architecture exit criteria
V0 implementation may start when:
- domain model is accepted
- ACP/runtime boundary is accepted
- Boss control bridge is accepted
- durable Task/Conversation separation is accepted
- policy/approval boundary is accepted
