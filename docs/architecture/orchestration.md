# Orchestration

## Boss model
Boss is not a special vendor integration. It is a registered agent selected for a project/run and granted orchestration capabilities.

```ts
type BossPolicy = {
  agentId: string;
  allowedOperations: (
    | "agents.discover"
    | "tasks.create"
    | "tasks.delegate"
    | "tasks.read"
    | "tasks.wait"
    | "messages.send"
    | "tasks.cancel"
    | "artifacts.read"
    | "artifacts.publish"
    | "approvals.request"
  )[];
  maxWorkers: number;
  maxTaskDepth: number;
};
```

Boss policy is a ceiling, not a grant to bypass the Policy Engine. The control plane evaluates each operation against the active project/task, bridge scopes, user policy, and execution boundary.

## Control Bridge
An ACP agent does not automatically gain control-plane tools merely by speaking ACP. The control plane defines one semantic bridge API with pluggable transports:
1. **MCP** — preferred when the ACP agent supports session-level MCP configuration.
2. **CLI** — `agentctl` fallback when a supported, constrained CLI path is available.
3. **Structured command** — validated commands when an adapter can safely deliver and validate them.
4. **none** — agent can execute assigned work but cannot initiate control-plane bridge operations.

Bridge transport and bridge scopes are separate. Scopes are a maximum tool surface configured for an agent; the actual session receives only the subset allowed for its active role, task, and policy.

### Boss eligibility
An agent is eligible to become Boss only when:
- `orchestration.canBeBoss` is true;
- its bridge transport is usable;
- it has the `boss.orchestration` scope;
- project/user policy permits the assignment.

The selected Boss receives the orchestration tools it needs, such as discovery, task creation/delegation, waiting, cancellation, and approval requests. It cannot change its own scopes or override policy.

### Session attachment
For supported ACP agents, attach the Fleet MCP server through `mcpServers` in `session/new` and `session/resume`. V0 defaults to a local stdio server. The server authenticates each request as the calling agent/session, validates project/task scope, and applies policy on every tool call. Recreate the authorized tool configuration on resume; do not depend on manually editing vendor-owned configuration files.

If the agent cannot consume the configured MCP server, use a configured CLI/structured adapter only when it is supported; otherwise the bridge is unavailable for that agent. All transports call the same application services.

## Bridge scopes
- `boss.orchestration`: discover agents, create/delegate/read/wait/cancel tasks, request approvals.
- `agent.messaging`: initiate routed messages to eligible agents within the caller's authorized project/task scope.
- `artifact.read`: read artifacts authorized for the active scope.
- `artifact.publish`: publish artifacts with provenance.
- `task.status`: read permitted task/assignment status.

An agent may be a worker without any bridge. Such a worker can receive an assignment and return its ACP result, but it cannot initiate a new control-plane message unless its session has `agent.messaging`. Boss-only operations must never be exposed just because a worker has messaging access.

## Dynamic roles
Role is assignment-local text/metadata. The Boss may create a role at runtime, for example:
- "concurrency safety reviewer"
- "Unity validation operator"
- "API compatibility researcher"

Agent selection is capability-driven plus policy constraints. The framework never hard-codes "Gemini = architect" or equivalent mappings.

## Task graphs
Tasks may form a DAG through parent/dependency relations. The framework provides graph execution primitives but does not prescribe phases such as research/design/implementation/review.

Example:
```text
root
 |-- task A ----\
 |              +--> task C --> task E
 |-- task B ----/              /
 +--> task D -----------------/
```

## Failure and retry
Retry creates a new execution attempt. A failed ACP Conversation is not rewritten into success. The Task preserves all attempts for audit.

Retry policy must distinguish:
- transient runner/process failure
- protocol failure
- worker-declared failure
- policy denial
- human rejection
- deterministic task failure

## Cancellation
Cancellation propagates from parent to children only when the parent policy says so. A Boss may cancel one worker without destroying sibling tasks.
